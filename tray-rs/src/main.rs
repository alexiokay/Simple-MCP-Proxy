//! Cross-platform system tray for MCP Vector Proxy.
//!
//! JSON-lines protocol over stdin/stdout:
//!   parent -> tray:  {"type":"menu","icon":"green","tooltip":"...","items":[{"title":"...","enabled":true,"separator":false}]}
//!   tray  -> parent: {"type":"click","seq_id":2}
//!
//! Items are rendered in order. Each non-separator, enabled item gets an auto-incremented
//! seq_id matching its position in the items array (skipping separators in the count).
//! The parent uses seq_id to route click events.

use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
};
use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[derive(Debug, Deserialize)]
struct MenuItemSpec {
    #[serde(default)]
    title: String,
    #[serde(default)]
    tooltip: Option<String>,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    separator: bool,
}
fn default_enabled() -> bool { true }

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum Msg {
    #[serde(rename = "menu")]
    Menu {
        icon: String,
        tooltip: String,
        items: Vec<MenuItemSpec>,
    },
}

#[derive(Debug, Serialize)]
struct ClickEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    seq_id: usize,
}

/// Event sent from stdin reader / menu channel into the main event loop.
enum UserEvent {
    Update(Msg),
    MenuClick(MenuEvent),
}

// Map from tray-icon internal menu id (stringified) -> seq_id the parent expects.
type SeqMap = Arc<Mutex<Vec<(String, usize)>>>;

fn main() {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Bridge tray-icon menu events into our event loop.
    let menu_channel = MenuEvent::receiver().clone();
    let proxy_for_menu = proxy.clone();
    thread::spawn(move || {
        for ev in menu_channel.iter() {
            let _ = proxy_for_menu.send_event(UserEvent::MenuClick(ev.clone()));
        }
    });

    // Read JSON-lines from stdin on a separate thread.
    let proxy_for_stdin = proxy.clone();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let reader = BufReader::new(stdin.lock());
        for line in reader.lines().flatten() {
            let line = line.trim();
            if line.is_empty() { continue; }
            match serde_json::from_str::<Msg>(line) {
                Ok(msg) => { let _ = proxy_for_stdin.send_event(UserEvent::Update(msg)); }
                Err(e) => {
                    let _ = writeln!(std::io::stderr(), "[mcp-tray] bad msg: {e}");
                }
            }
        }
        // stdin closed -> parent went away -> exit
        std::process::exit(0);
    });

    let mut tray: Option<TrayIcon> = None;
    let seq_map: SeqMap = Arc::new(Mutex::new(Vec::new()));
    // Keep MenuItem instances alive (muda uses Rc internally, but we hold owns to be safe).
    let mut kept_items: Vec<MenuItem> = Vec::new();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
            *control_flow = ControlFlow::Exit;
            return;
        }

        if let Event::UserEvent(ev) = event {
            match ev {
                UserEvent::MenuClick(menu_ev) => {
                    let id_str = menu_ev.id.0.clone();
                    let map = seq_map.lock().unwrap();
                    if let Some((_, seq_id)) = map.iter().find(|(k, _)| *k == id_str) {
                        let mut out = std::io::stdout().lock();
                        let _ = writeln!(
                            out,
                            "{}",
                            serde_json::to_string(&ClickEvent { kind: "click", seq_id: *seq_id }).unwrap()
                        );
                        let _ = out.flush();
                    }
                }
                UserEvent::Update(msg) => {
                    match msg {
                        Msg::Menu { icon, tooltip, items } => {
                            let (built_menu, new_pairs, new_items) = build_menu(&items);
                            *seq_map.lock().unwrap() = new_pairs;
                            kept_items = new_items;

                            let icon_bmp = icon_from_color(&icon);
                            let icon_obj = Icon::from_rgba(icon_bmp, 16, 16)
                                .unwrap_or_else(|_| Icon::from_rgba(vec![0, 0, 0, 0], 1, 1).unwrap());

                            tray = Some(match tray.take() {
                                Some(mut t) => {
                                    t.set_menu(Some(Box::new(built_menu)));
                                    t.set_icon(Some(icon_obj));
                                    let _ = t.set_tooltip(Some(tooltip));
                                    t
                                }
                                None => TrayIconBuilder::new()
                                    .with_menu(Box::new(built_menu))
                                    .with_icon(icon_obj)
                                    .with_tooltip(tooltip)
                                    .build()
                                    .expect("failed to build tray icon"),
                            });
                        }
                    }
                }
            }
        }
    });
}

/// Build the menu and return (Menu, seq_map, kept_items).
/// `seq_map` is a Vec of (internal_menu_id_string, seq_id) pairs.
/// `kept_items` owns the MenuItem objects so they live as long as the menu.
fn build_menu(items: &[MenuItemSpec]) -> (Menu, Vec<(String, usize)>, Vec<MenuItem>) {
    let menu = Menu::new();
    let mut seq_map = Vec::new();
    let mut kept: Vec<MenuItem> = Vec::new();
    let mut internal_idx = 0usize;

    for (seq_id, item) in items.iter().enumerate() {
        if item.separator {
            let _ = menu.append(&PredefinedMenuItem::separator());
            continue;
        }
        let id_str = internal_idx.to_string();
        let mi = MenuItem::with_id(MenuId::new(id_str.clone()), &item.title, item.enabled, None);
        let _ = menu.append(&mi);
        seq_map.push((id_str, seq_id));
        kept.push(mi);
        internal_idx += 1;
    }
    (menu, seq_map, kept)
}

/// Convert a color name to an RGBA byte buffer for a 16x16 icon.
/// Names: green, yellow, red, or hex like "#22c55e" / "22c55e".
/// Solid circle on transparent background.
fn icon_from_color(name: &str) -> Vec<u8> {
    let (r, g, b) = match name.to_ascii_lowercase().as_str() {
        "green" => (34, 197, 94),
        "yellow" => (234, 179, 8),
        "red" => (239, 68, 68),
        hex => parse_hex(hex).unwrap_or((234, 179, 8)),
    };

    const SIZE: usize = 16;
    let cx = 7.5_f32;
    let cy = 7.5_f32;
    let radius = 6_f32;
    let mut buf = Vec::with_capacity(SIZE * SIZE * 4);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let inside = (dx * dx + dy * dy).sqrt() <= radius;
            buf.push(r);
            buf.push(g);
            buf.push(b);
            buf.push(if inside { 255 } else { 0 });
        }
    }
    buf
}

fn parse_hex(s: &str) -> Option<(u8, u8, u8)> {
    let s = s.trim_start_matches('#');
    if s.len() != 6 { return None; }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some((r, g, b))
}
