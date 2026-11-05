use super::*;

type TagUsageSummary = (Vec<String>, Vec<(String, usize)>, usize, usize, usize);

impl MemoFile {

    pub fn read_notebook_tag_paths(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        let used = self.read_used_tag_ids_for_notebook_id(Some(&notebook_id))?;
        let mut paths = std::collections::BTreeSet::new();
        for tag in used {
            let mut prefix = String::new();
            for segment in tag.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                paths.insert(prefix.clone());
            }
        }
        Ok(paths.into_iter().collect())
    }

    pub fn read_used_tag_ids_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<Vec<String>> {
        Ok(self
            .read_tag_usage_summary_for_notebook_id(notebook_id)?
            .1
            .into_iter()
            .map(|(tag, _)| tag)
            .collect())
    }

    pub fn read_tag_usage_summary_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<TagUsageSummary> {
        let notebook_id = self.notebook_id_for_index(notebook_id);
        if !self.note_index_is_ready(&notebook_id)? {
            return Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "Note index is not ready"));
        }
        self.note_tag_usage_summary(&notebook_id)
    }


    /// 路径式 tag 的 prefix → 去重笔记数。每个真实 tag `T` 拆出
    /// 所有前缀 (`T` 自身 + `T` 的每级祖先 fullPath), 然后每个 prefix
    /// 收集所有"挂载了 T 的笔记路径", 取 set 长度 (即有任意 tag
    /// 落在 prefix 之下的不同笔记数)。
    ///
    /// **为什么需要**: 之前侧栏 tree 用 `tagCounts` 累加, 一篇笔记
    /// 既有 `#中国/湖南` 又有 `#中国/广东` 会被 `中国` 节点算两次。
    /// 现在按 distinct note path 去重；1 篇笔记即使挂了多个子 tag，父节点
    /// 也只算 1。
    ///
    /// O(N×L) where N = (tag, note) pairs, L = 平均路径深度。典型
    /// 库 (10K notes × 3 tags × depth 2) ~ 60K HashMap insert, 远低于
    /// 1ms, 不需要 SQL 聚合优化。
    pub fn read_tag_prefix_counts_for_notebook_id(
        &self,
        notebook_id: Option<&str>,
    ) -> std::io::Result<std::collections::HashMap<String, usize>> {
        use std::collections::{HashMap, HashSet};

        let notebook_id = self.notebook_id_for_index(notebook_id);
        if !self.note_index_is_ready(&notebook_id)? {
            return Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "Note index is not ready"));
        }
        let pairs = self.note_tag_path_pairs(&notebook_id)?;

        let mut prefix_to_memos: HashMap<String, HashSet<String>> = HashMap::new();
        for (tag, note_key) in &pairs {
            let segments: Vec<&str> = tag.split('/').collect();
            for i in 1..=segments.len() {
                let prefix = segments[..i].join("/");
                prefix_to_memos
                    .entry(prefix)
                    .or_default()
                    .insert(note_key.clone());
            }
        }

        Ok(prefix_to_memos
            .into_iter()
            .map(|(k, v)| (k, v.len()))
            .collect())
    }
}
