use std::sync::Mutex;

use flowix_core::search::{BigramTokenizer, MemoIndex};
use tauri::{AppHandle, Manager};

use crate::app::state::AppState;
use crate::events as dispatcher;
use crate::lock_utils::{read_lock, write_lock};

#[derive(Debug, Default)]
struct RebuildState {
    generation: u64,
    in_flight_notebook: Option<String>,
}

/// Coordinates background index builds so repeated search keystrokes cannot
/// enqueue the same full-notebook rebuild, and an older notebook build can
/// never overwrite a newer one.
#[derive(Debug, Default)]
pub struct SearchRebuildCoordinator {
    state: Mutex<RebuildState>,
}

impl SearchRebuildCoordinator {
    fn schedule(&self, notebook_id: &str, force: bool) -> Option<u64> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| {
            tracing::error!("search rebuild coordinator lock poisoned, recovering");
            poisoned.into_inner()
        });
        if !force && state.in_flight_notebook.as_deref() == Some(notebook_id) {
            return None;
        }
        state.generation = state.generation.wrapping_add(1);
        state.in_flight_notebook = Some(notebook_id.to_owned());
        Some(state.generation)
    }

    fn commit_if_current(&self, notebook_id: &str, generation: u64, commit: impl FnOnce()) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| {
            tracing::error!("search rebuild coordinator lock poisoned, recovering");
            poisoned.into_inner()
        });
        if state.generation != generation
            || state.in_flight_notebook.as_deref() != Some(notebook_id)
        {
            return false;
        }
        commit();
        state.in_flight_notebook = None;
        true
    }
}

pub(crate) fn force_rebuild_index(state: &AppState, app: &AppHandle) {
    write_lock(&state.search, "search").mark_unloaded();
    schedule_rebuild(state, app, true);
}

pub(crate) fn rebuild_index_in_background(state: &AppState, app: &AppHandle) {
    schedule_rebuild(state, app, false);
}

fn schedule_rebuild(state: &AppState, app: &AppHandle, force: bool) {
    let app = app.clone();
    let nb = read_lock(&state.memo_file, "memo_file")
        .current_notebook_id_value()
        .unwrap_or_default();
    let Some(generation) = state.search_rebuild.schedule(&nb, force) else {
        return;
    };
    if read_lock(&state.search, "search").current_notebook() != Some(nb.as_str()) {
        write_lock(&state.search, "search").mark_unloaded();
    }
    std::thread::spawn(move || {
        let st: tauri::State<AppState> = app.state();
        // Build into a private index. Search readers keep using the previous
        // snapshot and the global search write lock is held only for the swap.
        let mut next_index = MemoIndex::new(std::sync::Arc::new(BigramTokenizer));
        let (entries, notebook_path) = {
            let mf = read_lock(&st.memo_file, "memo_file");
            let entries = mf
                .read_index_for_notebook_id(Some(&nb))
                .ok()
                .flatten()
                .map(|index| index.memos)
                .unwrap_or_default();
            let path = mf
                .get_notebook_config_by_id(&nb)
                .map(|config| std::path::PathBuf::from(config.path));
            (entries, path)
        };
        let items = notebook_path
            .map(|base| {
                entries
                    .into_iter()
                    .filter(|entry| !entry.id.is_empty())
                    .map(|entry| {
                        let body = flowix_core::memo_file::notebook_path_from_relative(
                            &base,
                            &entry.relative_path,
                        )
                        .ok()
                        .and_then(|path| std::fs::read_to_string(path).ok())
                        .unwrap_or_default();
                        (entry, body)
                    })
                    .collect()
            })
            .unwrap_or_default();
        next_index.rebuild(nb.clone(), items);

        let current_notebook = read_lock(&st.memo_file, "memo_file").current_notebook_id_value();
        if current_notebook.as_deref() != Some(nb.as_str()) {
            let _ = st.search_rebuild.commit_if_current(&nb, generation, || {});
            return;
        }
        if !st.search_rebuild.commit_if_current(&nb, generation, || {
            *write_lock(&st.search, "search") = next_index;
        }) {
            return;
        }
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

#[cfg(test)]
mod tests {
    use super::SearchRebuildCoordinator;

    #[test]
    fn coalesces_repeated_rebuilds_for_one_notebook() {
        let coordinator = SearchRebuildCoordinator::default();
        let generation = coordinator.schedule("nb-a", false).unwrap();
        assert_eq!(coordinator.schedule("nb-a", false), None);
        assert!(coordinator.commit_if_current("nb-a", generation, || {}));
        assert!(coordinator.schedule("nb-a", false).is_some());
    }

    #[test]
    fn rejects_completion_from_an_older_generation() {
        let coordinator = SearchRebuildCoordinator::default();
        let old = coordinator.schedule("nb-a", false).unwrap();
        let current = coordinator.schedule("nb-b", false).unwrap();
        assert!(!coordinator.commit_if_current("nb-a", old, || {}));
        assert!(coordinator.commit_if_current("nb-b", current, || {}));
    }

    #[test]
    fn forced_rebuild_supersedes_same_notebook_work() {
        let coordinator = SearchRebuildCoordinator::default();
        let old = coordinator.schedule("nb-a", false).unwrap();
        let current = coordinator.schedule("nb-a", true).unwrap();
        assert!(!coordinator.commit_if_current("nb-a", old, || {}));
        assert!(coordinator.commit_if_current("nb-a", current, || {}));
    }
}
