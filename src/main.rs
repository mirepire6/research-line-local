#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod engine;
mod server;

use engine::AppResult;
use server::Paths;
use std::{env, path::PathBuf};

struct Options {
    paths: Paths,
    model: Option<String>,
    port: u16,
    headless: bool,
}

impl Options {
    fn load() -> AppResult<Self> {
        let exe = env::current_exe().map_err(|error| error.to_string())?;
        let program = exe
            .parent()
            .ok_or("The app folder is unavailable.")?
            .to_path_buf();
        let data = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(env::temp_dir)
            .join("ResearchLineLocal");
        let legacy = env::var_os("RESEARCH_LINE_LEGACY_ROOT").map(PathBuf::from);
        let mut options = Self {
            paths: Paths {
                program,
                data,
                legacy,
            },
            model: None,
            port: 46321,
            headless: false,
        };
        let mut args = env::args_os().skip(1);
        while let Some(key) = args.next() {
            let key = key.to_string_lossy();
            if key == "--headless" {
                options.headless = true;
                continue;
            }
            let value = args.next().ok_or_else(|| format!("{key} needs a value."))?;
            match key.as_ref() {
                "--app-dir" => options.paths.program = value.into(),
                "--data-dir" => options.paths.data = value.into(),
                "--legacy-root" => options.paths.legacy = Some(value.into()),
                "--model" => options.model = Some(value.to_string_lossy().into()),
                "--port" => {
                    options.port = value
                        .to_string_lossy()
                        .parse()
                        .map_err(|_| "Enter a valid local port.")?
                }
                _ => return Err(format!("Unknown option {key}.")),
            }
        }
        if let Some(root) = &options.paths.legacy
            && !root
                .join("Runtime")
                .join("tools")
                .join("agent.py")
                .is_file()
        {
            return Err(
                "The original Local AI Work setup wasn't found in the specified folder.".into(),
            );
        }
        Ok(options)
    }
}

fn start() -> AppResult<()> {
    let options = Options::load()?;
    let url = server::run(options.paths.clone(), options.port, options.model)?;
    if options.headless {
        println!("{url}");
        loop {
            std::thread::park();
        }
    }
    #[cfg(windows)]
    return desktop(url, options.paths.data);
    #[cfg(not(windows))]
    Err("The desktop window currently targets Windows.".into())
}

#[cfg(windows)]
fn desktop(url: String, data: PathBuf) -> AppResult<()> {
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::WindowBuilder,
    };
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    enum Action {
        Drag,
        Minimize,
        Maximize,
        Close,
        Open(String),
    }

    let event_loop = EventLoopBuilder::<Action>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("Local AI")
        .with_inner_size(LogicalSize::new(1100.0, 760.0))
        .with_min_inner_size(LogicalSize::new(680.0, 520.0))
        .with_decorations(false)
        .with_visible(false)
        .build(&event_loop)
        .map_err(|error| error.to_string())?;
    let allowed = url.clone();
    let mut context = WebContext::new(Some(data.join("webview")));
    let _webview = WebViewBuilder::new_with_web_context(&mut context).with_url(&url)
        .with_navigation_handler(move |target| {
            if target.starts_with(&allowed) { true } else { open_https(&target); false }
        })
        .with_new_window_req_handler(|target, _| {
            open_https(&target);
            NewWindowResponse::Deny
        })
        .with_ipc_handler(move |request| {
            let action = match request.body().as_str() {
                "drag" => Action::Drag, "minimize" => Action::Minimize,
                "maximize" => Action::Maximize, "close" => Action::Close,
                body => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else { return; };
                    let Some(url) = value["open"].as_str() else { return; };
                    Action::Open(url.to_owned())
                }
            };
            let _ = proxy.send_event(action);
        })
        .build(&window).map_err(|error| format!("Couldn't open WebView2. Install or repair the Microsoft Edge WebView2 Runtime. ({error})"))?;
    window.set_visible(true);
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            }
            | Event::UserEvent(Action::Close) => *flow = ControlFlow::Exit,
            Event::UserEvent(Action::Drag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(Action::Minimize) => window.set_minimized(true),
            Event::UserEvent(Action::Maximize) => window.set_maximized(!window.is_maximized()),
            Event::UserEvent(Action::Open(url)) => open_https(&url),
            _ => {}
        }
    });
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

#[cfg(windows)]
fn open_https(target: &str) {
    use std::ptr::null;
    use windows_sys::Win32::{UI::Shell::ShellExecuteW, UI::WindowsAndMessaging::SW_SHOWNORMAL};
    let Ok(url) = url::Url::parse(target) else {
        return;
    };
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return;
    }
    let verb = wide("open");
    let target = wide(url.as_str());
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        );
    }
}

fn main() {
    if let Err(error) = start() {
        eprintln!("{error}");
        #[cfg(windows)]
        if !env::args().any(|arg| arg == "--headless") {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MessageBoxW};
            let title = wide("Local AI");
            let message = wide(&error);
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    message.as_ptr(),
                    title.as_ptr(),
                    MB_ICONERROR,
                );
            }
        }
        std::process::exit(1);
    }
}
