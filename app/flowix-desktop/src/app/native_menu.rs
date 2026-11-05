use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{Emitter, Manager};

const SELECT_ALL_MENU_ID: &str = "flowix.select-all";
const SELECT_ALL_EVENT: &str = "flowix://editor-select-all";
const UNDO_MENU_ID: &str = "flowix.undo";
const UNDO_EVENT: &str = "flowix://editor-undo";
const REDO_MENU_ID: &str = "flowix.redo";
const REDO_EVENT: &str = "flowix://editor-redo";
const CUT_MENU_ID: &str = "flowix.cut";
const COPY_MENU_ID: &str = "flowix.copy";
const PASTE_MENU_ID: &str = "flowix.paste";
const CUT_EVENT: &str = "flowix://clipboard-cut";
const COPY_EVENT: &str = "flowix://clipboard-copy";
const PASTE_EVENT: &str = "flowix://clipboard-paste";
const FILE_SUBMENU_ID: &str = "flowix.file";
const EDIT_SUBMENU_ID: &str = "flowix.edit";
const VIEW_SUBMENU_ID: &str = "flowix.view";

struct MenuLabels {
    about: &'static str,
    services: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    quit: &'static str,
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    help: &'static str,
    close_window: &'static str,
    minimize: &'static str,
    maximize: &'static str,
    fullscreen: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
}

fn menu_labels(language: &str) -> MenuLabels {
    if language.eq_ignore_ascii_case("en-US") || language.eq_ignore_ascii_case("en") {
        MenuLabels {
            about: "About",
            services: "Services",
            hide: "Hide",
            hide_others: "Hide Others",
            quit: "Quit",
            file: "File",
            edit: "Edit",
            view: "View",
            window: "Window",
            help: "Help",
            close_window: "Close Window",
            minimize: "Minimize",
            maximize: "Maximize",
            fullscreen: "Fullscreen",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
        }
    } else {
        MenuLabels {
            about: "关于",
            services: "服务",
            hide: "隐藏",
            hide_others: "隐藏其他",
            quit: "退出",
            file: "文件",
            edit: "编辑",
            view: "显示",
            window: "窗口",
            help: "帮助",
            close_window: "关闭窗口",
            minimize: "最小化",
            maximize: "缩放",
            fullscreen: "全屏",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "拷贝",
            paste: "粘贴",
            select_all: "全选",
        }
    }
}

/// Installs Flowix's application menu and routes native menu actions.
///
/// Tauri's predefined macOS edit items invoke Cocoa's responder chain. That
/// consumes their accelerators before ProseMirror can handle them, so Select
/// All, Undo, Redo and clipboard commands use regular items forwarded to the
/// focused WebView. Unclaimed clipboard commands return to the native responder.
pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .enable_macos_default_menu(false)
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let event_name = match event.id().as_ref() {
                SELECT_ALL_MENU_ID => SELECT_ALL_EVENT,
                UNDO_MENU_ID => UNDO_EVENT,
                REDO_MENU_ID => REDO_EVENT,
                CUT_MENU_ID => CUT_EVENT,
                COPY_MENU_ID => COPY_EVENT,
                PASTE_MENU_ID => PASTE_EVENT,
                _ => return,
            };
            if let Some(window) = app
                .webview_windows()
                .into_values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                let _ = window.emit(event_name, ());
            }
        })
}

fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    build_app_menu_for_language(app, "zh-CN")
}

/// Rebuild the native menu after the persisted frontend language is loaded.
/// The menu is rebuilt instead of mutating individual items because Tauri's
/// predefined menu items do not expose stable IDs.
pub fn set_language(app: &tauri::AppHandle, language: &str) -> tauri::Result<()> {
    let menu = build_app_menu_for_language(app, language)?;
    app.set_menu(menu)?;
    Ok(())
}

fn build_app_menu_for_language(
    app: &tauri::AppHandle,
    language: &str,
) -> tauri::Result<Menu<tauri::Wry>> {
    let package = app.package_info();
    let config = app.config();
    let labels = menu_labels(language);
    let about_text = format!("{} {}", labels.about, package.name);
    let hide_text = format!("{} {}", labels.hide, package.name);
    let quit_text = format!("{} {}", labels.quit, package.name);
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        labels.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(labels.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(labels.maximize))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(labels.close_window))?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        labels.help,
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, Some(about_text.as_str()), Some(about.clone()))?,
        ],
    )?;
    let select_all = MenuItem::with_id(
        app,
        SELECT_ALL_MENU_ID,
        labels.select_all,
        true,
        Some("CmdOrCtrl+A"),
    )?;
    // Cocoa's predefined Undo/Redo items operate on WebKit's native undo
    // manager. ProseMirror transactions (managed paste, async attachments,
    // atom deletion) do not live in that stack, so route the accelerators to
    // the focused WebView and let NativeEditMenuBridge choose the native title
    // field or the ProseMirror command explicitly.
    let undo = MenuItem::with_id(app, UNDO_MENU_ID, labels.undo, true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(
        app,
        REDO_MENU_ID,
        labels.redo,
        true,
        Some("CmdOrCtrl+Shift+Z"),
    )?;

    // Generic tree rows do not have a native text selection. Cocoa otherwise
    // disables Cut and consumes Cmd+X before the WebView sees a keydown.
    #[cfg(target_os = "macos")]
    let cut = MenuItem::with_id(app, CUT_MENU_ID, labels.cut, true, Some("CmdOrCtrl+X"))?;
    #[cfg(target_os = "macos")]
    let copy = MenuItem::with_id(app, COPY_MENU_ID, labels.copy, true, Some("CmdOrCtrl+C"))?;
    #[cfg(target_os = "macos")]
    let paste = MenuItem::with_id(app, PASTE_MENU_ID, labels.paste, true, Some("CmdOrCtrl+V"))?;
    #[cfg(not(target_os = "macos"))]
    let cut = PredefinedMenuItem::cut(app, Some(labels.cut))?;
    #[cfg(not(target_os = "macos"))]
    let copy = PredefinedMenuItem::copy(app, Some(labels.copy))?;
    #[cfg(not(target_os = "macos"))]
    let paste = PredefinedMenuItem::paste(app, Some(labels.paste))?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                package.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, Some(about_text.as_str()), Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, Some(labels.services))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some(hide_text.as_str()))?,
                    &PredefinedMenuItem::hide_others(app, Some(labels.hide_others))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(quit_text.as_str()))?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_id_and_items(
                app,
                FILE_SUBMENU_ID,
                labels.file,
                true,
                &[
                    &PredefinedMenuItem::close_window(app, Some(labels.close_window))?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, Some(labels.quit))?,
                ],
            )?,
            &Submenu::with_id_and_items(
                app,
                EDIT_SUBMENU_ID,
                labels.edit,
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(app)?,
                    &cut,
                    &copy,
                    &paste,
                    &select_all,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_id_and_items(
                app,
                VIEW_SUBMENU_ID,
                labels.view,
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some(labels.fullscreen),
                )?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

/// Preserve the native text/image clipboard pipeline when no app surface claims
/// an edit-menu action. Sending the selector invokes WebKit, not our menu item.
#[tauri::command]
pub fn perform_native_clipboard_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), String> {
    if !matches!(action.as_str(), "cut" | "copy" | "paste") {
        return Err("INVALID_CLIPBOARD_ACTION".into());
    }
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        app.run_on_main_thread(move || {
            if !window.is_focused().unwrap_or(false) {
                return;
            }
            let Some(marker) = objc2::MainThreadMarker::new() else {
                return;
            };
            let selector = match action.as_str() {
                "cut" => objc2::sel!(cut:),
                "copy" => objc2::sel!(copy:),
                _ => objc2::sel!(paste:),
            };
            // All selectors are standard NSResponder clipboard commands, with
            // AppKit choosing the currently focused text field or WebView.
            unsafe {
                objc2_app_kit::NSApp(marker).sendAction_to_from(selector, None, None);
            }
        })
        .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    window
        .eval(&format!(
            "document.execCommand({})",
            serde_json::to_string(&action).map_err(|error| error.to_string())?
        ))
        .map_err(|error| error.to_string())
}
