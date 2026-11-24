use super::*;

pub(in crate::commands::cloud) fn safe_cloud_file_path(
    base: &Path,
    filename: &str,
    attachment: bool,
) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    let user_data =
        !attachment && flowix_core::memo_file::FileManagementPolicy::is_user_data_path(candidate);
    if (!attachment && !candidate.is_md())
        || (attachment && !filename.starts_with("attachments/"))
        || filename.contains('\\')
        || filename.starts_with('/')
        || candidate
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || candidate
            .components()
            .enumerate()
            .any(|(index, component)| {
                component.as_os_str().to_string_lossy().starts_with('.')
                    && !(user_data && index == 0)
            })
    {
        return Err("INVALID_CLOUD_FILENAME".to_string());
    }
    let mut path = base.to_path_buf();
    for component in candidate.components() {
        path.push(component.as_os_str());
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() {
                return Err("CLOUD_PATH_SYMLINK".to_string());
            }
        }
    }
    Ok(path)
}

pub(in crate::commands::cloud) fn safe_cloud_collection_path(
    base: &Path,
    filename: &str,
) -> Result<PathBuf, String> {
    let candidate = Path::new(filename);
    if !flowix_core::collection::is_collection_document_path(candidate)
        || filename.contains('\\')
        || filename.starts_with('/')
        || candidate
            .components()
            .enumerate()
            .any(|(index, component)| {
                let std::path::Component::Normal(name) = component else {
                    return true;
                };
                let name = name.to_string_lossy();
                name.starts_with('.')
                    && !(index + 1 == candidate.components().count()
                        && name.eq_ignore_ascii_case(".index.yaml"))
            })
    {
        return Err("INVALID_CLOUD_COLLECTION_FILENAME".to_string());
    }
    let mut path = base.to_path_buf();
    for component in candidate.components() {
        path.push(component.as_os_str());
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("CLOUD_PATH_SYMLINK".to_string());
        }
    }
    Ok(path)
}

pub(in crate::commands::cloud) fn safe_cloud_note_path(
    base: &Path,
    filename: &str,
) -> Result<PathBuf, String> {
    safe_cloud_file_path(base, filename, false)
}
