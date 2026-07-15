use crate::agent_flowix::prompt::{build_system_prompt, SystemPromptConfig};
use crate::agent_flowix::tools::get_all_tools;
use crate::config::AiModelConfig;
use flowix_core::memo_file::extract_body_content;

use super::provider::{build_chat_provider, AgentInstance};
use super::{AgentError, AgentManager, AgentUserMessage};

pub(super) struct CachedInstance {
    pub(super) config: AiModelConfig,
    pub(super) instance: AgentInstance,
}

impl AgentManager {
    /// 拿到与当前 ai_config 对应的 provider 实例; 配置缺 model 则报错。
    ///
    /// 走双读锁: 先 read 尝试命中缓存, 不命中再升级到 write 重建。这样并发 chat
    /// 不会互相阻塞 — 只有真正发生配置变更时才有写锁竞争。
    pub(super) async fn ensure_instance(
        &self,
        config: &AiModelConfig,
    ) -> Result<AgentInstance, AgentError> {
        if config.model.trim().is_empty() {
            return Err(AgentError::NotConfigured);
        }
        {
            let guard = self.instance.read().await;
            if let Some(cached) = guard.as_ref() {
                if &cached.config == config {
                    return Ok(cached.instance.clone());
                }
            }
        }
        let instance = self.build_instance(config)?;
        let mut guard = self.instance.write().await;
        *guard = Some(CachedInstance {
            config: config.clone(),
            instance: instance.clone(),
        });
        Ok(instance)
    }

    /// Build the system prompt for `config`, optionally substituting the
    /// default role section with a runtime-supplied Agent Role.
    /// Pass `None` for `role_override` to use the default static role
    /// (see [`crate::agent_flowix::prompt::role::section`]).
    pub(super) fn base_system_prompt(
        &self,
        config: &AiModelConfig,
        role_override: Option<&str>,
    ) -> String {
        build_system_prompt(SystemPromptConfig {
            model: &config.model,
            tools_enabled: true,
            skills: self.skill_store.summaries(),
            role_override,
        })
    }

    fn build_instance(&self, config: &AiModelConfig) -> Result<AgentInstance, AgentError> {
        self.build_instance_with_system_prompt(config, self.base_system_prompt(config, None))
    }

    pub(super) fn build_instance_with_system_prompt(
        &self,
        config: &AiModelConfig,
        system_prompt: String,
    ) -> Result<AgentInstance, AgentError> {
        let tools = get_all_tools();
        let provider = build_chat_provider(config, system_prompt, &tools)?;

        Ok(AgentInstance { provider, tools })
    }

    pub(super) fn agent_role_system_section(&self, message: &AgentUserMessage) -> Option<String> {
        let memo_id = message.agent_role_memo_id.as_deref()?.trim();
        if memo_id.is_empty() {
            return None;
        }

        let role_body = {
            let memo_file = self.memo_file.read().ok()?;
            let (_entry, content) = memo_file.read_memo_with_body_global(memo_id)?;
            extract_body_content(&content).trim().to_string()
        };

        if role_body.is_empty() {
            return None;
        }

        let role_name = message
            .agent_role_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("未命名角色");

        Some(format!(
            "# Agent Role\nRole name: {role_name}\n\n<role-instructions>\n{role_body}\n</role-instructions>"
        ))
    }
}
