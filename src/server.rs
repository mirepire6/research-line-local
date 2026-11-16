use crate::engine::{self, AppResult, ChatInput, Emit, Model, Settings};
use percent_encoding::percent_decode_str;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const MAX_DOCUMENT: usize = 25 * 1024 * 1024;
const MAX_CHAT: usize = 2 * 1024 * 1024;
const FILE_TYPES: &[&str] = &[
    "pdf", "docx", "xlsx", "xls", "pptx", "html", "htm", "csv", "tsv", "txt", "md", "json", "xml",
];
const INDEX: &str = include_str!("../ui/index.html");
const APP_CSS: &[u8] = include_bytes!("../ui/app.css");
const APP_JS: &[u8] = include_bytes!("../ui/app.js");

#[derive(Clone)]
pub struct Paths {
    pub program: PathBuf,
    pub data: PathBuf,
    pub legacy: Option<PathBuf>,
}

struct App {
    paths: Paths,
    host: String,
    token: String,
    settings: Mutex<Settings>,
    active: Mutex<Option<Arc<AtomicBool>>>,
}

pub fn run(paths: Paths, preferred_port: u16, model: Option<String>) -> AppResult<String> {
    fs::create_dir_all(&paths.data).map_err(|error| error.to_string())?;
    let settings_path = paths.data.join("settings.json");
    let mut settings: Settings = fs::read(settings_path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    if let Some(model) = model {
        settings.model = model;
    }
    let settings = settings.validate()?;
    let server = Server::http(("127.0.0.1", preferred_port))
        .map_err(|error| format!("Couldn't open the local desktop port: {error}"))?;
    let host = server
        .server_addr()
        .to_ip()
        .ok_or("Couldn't obtain the local desktop address.")?
        .to_string();
    let url = format!("http://{host}/");
    let app = Arc::new(App {
        paths,
        host,
        token: secret()?,
        settings: Mutex::new(settings),
        active: Mutex::new(None),
    });
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = Arc::clone(&app);
            thread::spawn(move || handle(app, request));
        }
    });
    Ok(url)
}

fn secret() -> AppResult<String> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("constant response header")
}

fn send(req: Request, status: u16, mimetype: &str, data: Vec<u8>) {
    let _ = req.respond(Response::from_data(data)
        .with_status_code(StatusCode(status))
        .with_header(header("Content-Type", mimetype))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'")));
}

fn json_reply(req: Request, status: u16, data: Value) {
    send(
        req,
        status,
        "application/json; charset=utf-8",
        data.to_string().into_bytes(),
    );
}

fn failure(req: Request, status: u16, message: impl Into<String>) {
    json_reply(req, status, json!({"message":message.into()}));
}

fn incoming_header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|item| item.field.equiv(name))
        .map(|item| item.value.as_str())
}

fn handle(app: Arc<App>, mut req: Request) {
    if incoming_header(&req, "Host") != Some(app.host.as_str()) {
        failure(req, 403, "Use the app's loopback address.");
        return;
    }
    let path = req.url().split('?').next().unwrap_or("/").to_owned();
    let method = req.method().clone();
    if path.starts_with("/api/")
        && !incoming_header(&req, "Authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| token == app.token)
    {
        failure(req, 403, "Open Local AI again to start a new session.");
        return;
    }
    match (&method, path.as_str()) {
        (&Method::Get, "/") => send(
            req,
            200,
            "text/html; charset=utf-8",
            INDEX.replace("__LOCAL_AI_TOKEN__", &app.token).into_bytes(),
        ),
        (&Method::Get, "/app.css") => send(req, 200, "text/css; charset=utf-8", APP_CSS.to_vec()),
        (&Method::Get, "/app.js") => {
            send(req, 200, "text/javascript; charset=utf-8", APP_JS.to_vec())
        }
        (&Method::Get, "/api/status") => {
            let settings = app.settings.lock().unwrap().clone();
            let result = engine::active_model(&settings);
            json_reply(
                req,
                200,
                json!({"connected":result.is_ok(),
                "model":result.unwrap_or(settings.model), "endpoint":settings.endpoint,
                "accent":system_accent(), "legacy":app.paths.legacy.is_some(),
                "converter":converter_exists(&app.paths.program)}),
            );
        }
        (&Method::Get, "/api/settings") => {
            json_reply(req, 200, json!(*app.settings.lock().unwrap()));
        }
        (&Method::Put, "/api/settings") => {
            let next = read_bounded(&mut req, 8192)
                .and_then(|bytes| {
                    serde_json::from_slice::<Settings>(&bytes)
                        .map_err(|_| "Settings format is invalid.".into())
                })
                .and_then(Settings::validate);
            let next = match next {
                Ok(settings) => settings,
                Err(error) => {
                    failure(req, 400, error);
                    return;
                }
            };
            let mut settings = app.settings.lock().unwrap();
            match write_settings(&app.paths.data, &next) {
                Ok(()) => {
                    *settings = next;
                    json_reply(req, 200, json!(*settings));
                }
                Err(error) => failure(req, 500, error),
            }
        }
        (&Method::Post, "/api/chat") => chat(app, req),
        (&Method::Post, "/api/cancel") => {
            if let Some(stop) = app.active.lock().unwrap().as_ref() {
                stop.store(true, Ordering::Relaxed);
            }
            json_reply(req, 200, json!({"ok":true}));
        }
        (&Method::Post, "/api/documents/convert") => match convert(&app.paths, &mut req) {
            Ok(value) => json_reply(req, 200, value),
            Err(error) => failure(req, 400, error),
        },
        _ => failure(req, 404, "This page isn't available."),
    }
}

fn write_settings(path: &Path, settings: &Settings) -> AppResult<()> {
    let temporary = path.join("settings.json.next");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path.join("settings.json")).map_err(|error| error.to_string())
}

fn read_bounded(req: &mut Request, max: usize) -> AppResult<Vec<u8>> {
    if req.body_length().is_some_and(|size| size > max) {
        return Err("The upload is too large.".into());
    }
    let mut data = Vec::new();
    req.as_reader()
        .take(max as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    if data.len() > max {
        return Err("The upload is too large.".into());
    }
    Ok(data)
}

fn chat(app: Arc<App>, mut req: Request) {
    let input = read_bounded(&mut req, MAX_CHAT).and_then(|bytes| {
        serde_json::from_slice::<ChatInput>(&bytes)
            .map_err(|_| "The chat request is invalid.".into())
    });
    let input = match input {
        Ok(value) => value,
        Err(error) => {
            failure(req, 400, error);
            return;
        }
    };
    if !matches!(
        input.mode.as_str(),
        "agent" | "chat" | "web" | "deep" | "folder"
    ) || input.messages.is_empty()
        || input.messages.len() > 128
        || input
            .messages
            .iter()
            .any(|item| !matches!(item.role.as_str(), "user" | "assistant"))
    {
        failure(req, 400, "The chat mode or message list is invalid.");
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut active = app.active.lock().unwrap();
        if active.is_some() {
            failure(req, 409, "The previous request is still ending.");
            return;
        }
        *active = Some(Arc::clone(&stop));
    }
    let settings = app.settings.lock().unwrap().clone();
    let mut writer = req.into_writer();
    let headers = b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nCache-Control: no-store\r\nTransfer-Encoding: chunked\r\n\r\n";
    if writer.write_all(headers).is_err() {
        *app.active.lock().unwrap() = None;
        return;
    }
    let mut emit = |event: Value| {
        let line = format!("{event}\n");
        let chunk = format!("{:x}\r\n{line}\r\n", line.len());
        if writer
            .write_all(chunk.as_bytes())
            .and_then(|()| writer.flush())
            .is_err()
        {
            stop.store(true, Ordering::Relaxed);
        }
    };
    emit(json!({"type":"status","message":"Connecting to the local model…"}));
    let result = (|| {
        engine::check_stop(&stop)?;
        let model = Model::connect(&settings)?;
        let mode = engine::mode(&model, &input, &stop)?;
        if mode == "folder" {
            legacy(
                &app.paths,
                &settings,
                &input,
                &model.id,
                Arc::clone(&stop),
                &mut emit,
            )
        } else {
            engine::run(&model, &input, &mode, &stop, &mut emit)
        }
    })();
    *app.active.lock().unwrap() = None;
    match result {
        Ok(()) => emit(json!({"type":"done"})),
        Err(message) => emit(json!({"type":"error","message":message})),
    }
    let _ = writer.write_all(b"0\r\n\r\n").and_then(|()| writer.flush());
}

fn hidden_command(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn converter_python(program: &Path) -> PathBuf {
    program.join(".venv").join("Scripts").join("python.exe")
}

fn converter_exists(program: &Path) -> bool {
    converter_python(program).is_file() && program.join("converter").join("convert.py").is_file()
}

fn convert(paths: &Paths, req: &mut Request) -> AppResult<Value> {
    if !converter_exists(&paths.program) {
        return Err("Set up MarkItDown with scripts/setup-markitdown.ps1 in the app folder, then try again.".into());
    }
    let name = incoming_header(req, "X-Filename").ok_or("Choose a document first.")?;
    let name = percent_decode_str(name)
        .decode_utf8()
        .map_err(|_| "The file name is invalid.")?
        .into_owned();
    if name.is_empty()
        || name
            .chars()
            .any(|char| char.is_control() || matches!(char, '/' | '\\' | ':'))
        || name.len() > 512
    {
        return Err("The file name is invalid.".into());
    }
    let extension = Path::new(&name)
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or("The document must have a supported file extension.")?
        .to_ascii_lowercase();
    if !FILE_TYPES.contains(&extension.as_str()) {
        return Err(
            "This file type isn't supported. Try PDF, Word, Excel, PowerPoint, HTML, or text."
                .into(),
        );
    }
    let data = read_bounded(req, MAX_DOCUMENT)?;
    if data.is_empty() {
        return Err("The document is empty.".into());
    }
    let staging = paths.data.join("imports");
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let staged = staging.join(format!("{}.{}", secret()?, extension));
    let conversion = (|| {
        let mut output = File::create_new(&staged).map_err(|error| error.to_string())?;
        output.write_all(&data).map_err(|error| error.to_string())?;
        drop(output);
        let mut command = Command::new(converter_python(&paths.program));
        let result = hidden_command(&mut command)
            .args(["-I", "-X", "utf8"])
            .arg(paths.program.join("converter").join("convert.py"))
            .arg(&staged)
            .current_dir(&paths.program)
            .output()
            .map_err(|error| error.to_string())?;
        if !result.status.success() {
            let message = String::from_utf8_lossy(&result.stderr);
            return Err(engine::shorten(message.trim(), 400).to_owned());
        }
        let mut converted: Value = serde_json::from_slice(&result.stdout)
            .map_err(|_| "MarkItDown didn't return a document.")?;
        converted["name"] = json!(name);
        Ok(converted)
    })();
    let _ = fs::remove_file(staged);
    conversion
}

fn legacy(
    paths: &Paths,
    settings: &Settings,
    input: &ChatInput,
    model: &str,
    stop: Arc<AtomicBool>,
    emit: Emit,
) -> AppResult<()> {
    let Some(root) = &paths.legacy else {
        return Err("Folder helper needs an optional compatible Local AI Work and Sandbox setup. Use attachments for document chat.".into());
    };
    if settings.endpoint != Settings::default().endpoint {
        return Err("Folder helper uses the original LM Studio server on port 1234.".into());
    }
    let (last, history) = input
        .messages
        .split_last()
        .ok_or("Write a message to send.")?;
    let python = root
        .join("Runtime")
        .join("tools-venv")
        .join("Scripts")
        .join("python.exe");
    let mut command = Command::new(python);
    let mut child = hidden_command(&mut command)
        .args([
            "-X",
            "utf8",
            "-u",
            "-c",
            include_str!("../bridge/legacy.py"),
        ])
        .arg(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .current_dir(root)
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Folder helper could not read the request.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Folder helper could not return a response.")?;
    writeln!(
        stdin,
        "{}",
        json!({"question":last.content,"history":history,"model":model})
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())?;
    let finished = Arc::new(AtomicBool::new(false));
    let watcher_finished = Arc::clone(&finished);
    let monitor = thread::spawn(move || {
        while !watcher_finished.load(Ordering::Relaxed) {
            if stop.load(Ordering::Relaxed) {
                let _ = writeln!(stdin, "STOP");
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let mut error_message = None;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if event["type"] == "error" {
                error_message = event["message"].as_str().map(str::to_owned);
            } else {
                emit(event);
            }
        }
    }
    finished.store(true, Ordering::Relaxed);
    let _ = monitor.join();
    let status = child.wait().map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(error_message.unwrap_or_else(|| "The optional folder helper couldn't finish.".into()))
    }
}

fn system_accent() -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::DwmGetColorizationColor;
        let mut color = 0;
        let mut opaque = 0;
        if unsafe { DwmGetColorizationColor(&mut color, &mut opaque) } == 0 {
            return Some(format!("#{:06x}", color & 0xffffff));
        }
    }
    None
}
