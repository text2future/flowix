use crate::runtime_log;

pub fn install_panic_log_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("panic payload is not a string");
        runtime_log::record_event(
            "error",
            "app.panic",
            format!("panic at {location}: {message}"),
        );
        default_hook(info);
    }));
}
