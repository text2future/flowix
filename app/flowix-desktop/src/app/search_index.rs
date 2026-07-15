use tauri::{AppHandle, Manager};

use crate::app::state::AppState;
use crate::events as dispatcher;
use crate::lock_utils::{read_lock, write_lock};

pub(crate) fn force_rebuild_index(state: &AppState, app: &AppHandle) {
    write_lock(&state.search, "search").mark_unloaded();
    rebuild_index_in_background(state, app);
}

pub(crate) fn rebuild_index_in_background(state: &AppState, app: &AppHandle) {
    let app = app.clone();
    let nb = state
        .memo_file
        .read()
        .unwrap()
        .current_notebook_id_value()
        .unwrap_or_default();
    std::thread::spawn(move || {
        let st: tauri::State<AppState> = app.state();
        let mf = read_lock(&st.memo_file, "memo_file");
        let mut index = write_lock(&st.search, "search");
        flowix_core::search::rebuild_index_from_store(&mut index, &mf, nb);
        dispatcher::emit_to(&app, "search-index-ready", ());
    });
}

pub(crate) fn try_index_upsert(state: &AppState, id: &str) {
    let mf = read_lock(&state.memo_file, "memo_file");
    let mut idx = write_lock(&state.search, "search");
    let _ = flowix_core::search::upsert_index_from_store(&mut idx, &mf, id);
}

pub(crate) fn try_index_remove(state: &AppState, id: &str) {
    let mut idx = write_lock(&state.search, "search");
    let _ = flowix_core::search::remove_from_index(&mut idx, id);
}
