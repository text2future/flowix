'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Gauge, Loader2, LockKeyhole, MessageSquareText, Plug, Sparkles, UsersRound, Wrench } from 'lucide-react';
import { agent, type CodexProjectCapabilities } from '@platform/tauri/client';
import { useMemoStore, type Notebook } from '@features/memo';
import { Button } from '@shared/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@shared/ui/select';
import { displayNameForComposerSkill } from '@features/agent/thread-card/composer/composer-skill-token';
import { cn } from '@/lib/utils';

type CodexSection = 'model' | 'permissions' | 'connections' | 'skills' | 'prompts' | 'agents' | 'other';
type JsonObject = Record<string, unknown>;
const obj = (v: unknown): JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown, fallback = '') => typeof v === 'string' ? v : fallback;
const bool = (v: unknown, fallback = false) => typeof v === 'boolean' ? v : fallback;
const resultValue = (v: unknown) => obj(obj(v).value);
const resultError = (v: unknown) => obj(v).ok === false ? str(obj(v).error, 'Codex App Server 查询失败') : '';
const selectClass = 'h-8 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]';
type SelectOption = { value: string; label: string };
const optionLabels: Record<string, string> = {
  low: '低', medium: '中', high: '高', xhigh: '极高', auto: '自动', default: '默认', flex: '灵活', priority: '优先',
  disabled: '禁用', cached: '缓存结果', indexed: '索引搜索', live: '实时搜索', untrusted: '不受信任时询问',
  'on-failure': '失败时询问', 'on-request': '按需询问', never: '从不询问', user: '用户确认', auto_review: '自动审核',
  'read-only': '只读', 'workspace-write': '工作区读写', 'danger-full-access': '完全访问', stdio: '本地命令（stdio）', http: '远程服务（HTTP）',
};
const options = (values: string[]): SelectOption[] => values.map((value) => ({ value, label: optionLabels[value] ?? value }));
const normalizeNotebookPath = (path: string) => path.replace(/[\\/]+$/, '').toLowerCase();

export function CodexSettingsSection({ notebookPath }: { notebookPath?: string } = {}) {
  const currentNotebook = useMemoStore((s) => s.selectedNotebook);
  const notebooks = useMemoStore((s) => s.notebooks);
  const initialized = useMemoStore((s) => s.notebooksInitialized);
  const loadNotebooks = useMemoStore((s) => s.loadNotebooks);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [section, setSection] = useState<CodexSection>('model');
  const [catalog, setCatalog] = useState<CodexProjectCapabilities | null>(null);
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => { if (!initialized) void loadNotebooks(); }, [initialized, loadNotebooks]);
  useEffect(() => {
    if (currentNotebook?.id) setSelectedNotebookId(currentNotebook.id);
  }, [currentNotebook?.id]);
  const notebook = notebookPath
    ? notebooks.find((item) => normalizeNotebookPath(item.path) === normalizeNotebookPath(notebookPath))
      ?? (currentNotebook && normalizeNotebookPath(currentNotebook.path) === normalizeNotebookPath(notebookPath) ? currentNotebook : null)
    : notebooks.find((item) => item.id === selectedNotebookId) ?? currentNotebook;
  const refresh = useCallback(async (force = false) => {
    if (!notebook?.path) return;
    const request = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = await agent.getCodexProjectCapabilities(notebook.path, force);
      if (request !== generation.current) return;
      setCatalog(next);
      const config = obj(resultValue(next.config).config);
      const nextModels = arr(resultValue(next.models).data).map(obj);
      const defaultModel = nextModels.find((item) => bool(item.isDefault));
      setForm({
        model: str(config.model, str(defaultModel?.model, str(defaultModel?.id))), model_reasoning_effort: str(config.model_reasoning_effort, str(defaultModel?.defaultReasoningEffort, 'medium')),
        model_verbosity: str(config.model_verbosity, 'medium'), review_model: str(config.review_model),
        service_tier: str(config.service_tier, 'auto'), web_search: str(config.web_search, 'disabled'),
        approval_policy: str(config.approval_policy, 'on-request'),
        approvals_reviewer: str(config.approvals_reviewer, 'user'),
        sandbox_mode: str(config.sandbox_mode, 'workspace-write'),
        network_access: bool(obj(config.sandbox_workspace_write).network_access),
        instructions: str(config.instructions),
        developer_instructions: str(config.developer_instructions),
      });
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (request === generation.current) setLoading(false); }
  }, [notebook?.path]);
  useEffect(() => { setCatalog(null); setNotice(null); void refresh(); return () => { generation.current += 1; }; }, [refresh]);

  const config = obj(resultValue(catalog?.config).config);
  const models = arr(resultValue(catalog?.models).data).map(obj).filter((x) => !bool(x.hidden));
  const skills = arr(resultValue(catalog?.skills).data).flatMap((x) => arr(obj(x).skills).map(obj));
  const runtimeMcp = arr(resultValue(catalog?.mcp).data).map(obj);
  const mcp = Object.entries(obj(config.mcpServers ?? config.mcp_servers)).map(([name, item]) => ({
    ...obj(item), ...obj(runtimeMcp.find((x) => str(x.name) === name)), name,
  }));
  const configuredAgents = Object.entries(obj(config.agents)).map(([name, item]) => ({ ...obj(item), name }));
  const agents = [...configuredAgents, ...arr(resultValue(catalog?.agents).data).map(obj)];
  const installed = flattenPlugins(resultValue(catalog?.plugins));
  const available = flattenPlugins(resultValue(catalog?.pluginCatalog));
  const installedIds = new Set(installed.flatMap((x) => [str(x.id), str(x.name)].filter(Boolean)));
  const projectVersion = useMemo(() => {
    const folder = `${notebook?.path.replace(/[\\/]+$/, '')}\\.codex`.replace(/\//g, '\\').toLowerCase();
    const layer = arr(resultValue(catalog?.config).layers).map(obj).find((x) => {
      const name = obj(x.name);
      return name.type === 'project' && str(name.dotCodexFolder).replace(/\//g, '\\').toLowerCase() === folder;
    });
    return str(layer?.version) || null;
  }, [catalog, notebook?.path]);

  const save = async (keys: string[], preserveEmpty = false) => {
    if (!notebook) return;
    setSaving('config'); setError(null); setNotice(null);
    try {
      const edits = keys.map((keyPath) => ({ keyPath, value: keyPath === 'sandbox_workspace_write.network_access' ? form.network_access : form[keyPath], mergeStrategy: 'replace' as const }))
        .filter((edit) => preserveEmpty || edit.value !== '');
      const result = await agent.writeCodexProjectConfig(notebook.path, edits, projectVersion);
      setNotice(result.status === 'okOverridden' ? '已保存，但部分值被高优先级策略覆盖。' : '项目配置已保存；会话静态设置将在新会话中生效。');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(null); }
  };
  const run = async (key: string, action: () => Promise<unknown>, message: string, force = false) => {
    setSaving(key); setError(null); setNotice(null);
    try { await action(); setNotice(message); await refresh(force); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setSaving(null); }
  };

  if (!notebook) return <div className="space-y-5"><Empty icon={Sparkles} title="没有当前笔记本" text="请先在主窗口选择一个笔记本。" /></div>;
  const navigation: Array<[CodexSection, string, typeof Gauge]> = [
    ['model', '模型', Gauge],
    ['permissions', '权限', LockKeyhole],
    ['connections', '连接', Plug],
    ['skills', '技能', Sparkles],
    ['prompts', '提示词', MessageSquareText],
    ['agents', '子Agent', UsersRound],
    ['other', '其他', Wrench],
  ];
  const sectionMeta: Record<CodexSection, { title: string; description: string }> = {
    model: { title: '模型与运行参数', description: '设置写入当前笔记本的 .codex/config.toml。模型和推理设置对新会话生效。' },
    permissions: { title: '审批与 Sandbox', description: '保存时 Codex 会再次校验组织策略；高优先级策略可以覆盖项目值。' },
    connections: { title: '连接', description: '管理当前笔记本项目使用的 MCP Server。' },
    skills: { title: '技能', description: '管理当前项目发现的 Skill，也可以创建新的项目 Skill。' },
    prompts: { title: '提示词', description: '设置当前笔记本项目的默认指令，保存后写入 .codex/config.toml。' },
    agents: { title: '子Agent', description: '查看当前笔记本项目配置的子 Agent。' },
    other: { title: '其他', description: '管理 Codex 插件，并查看当前项目的能力概览。' },
  };
  return <div className="space-y-5">
    {!notebookPath && <ProjectHeader
      notebook={notebook}
      notebooks={notebooks}
      selectedNotebookId={selectedNotebookId ?? notebook.id}
      onNotebookChange={setSelectedNotebookId}
    />}
    <div className="grid gap-5 md:grid-cols-[196px_minmax(0,1fr)] md:items-start md:gap-0">
      <nav className="flex gap-1 overflow-x-auto rounded-xl border border-[var(--divider)] bg-[var(--card)] p-1 md:sticky md:top-0 md:min-h-0 md:w-[196px] md:shrink-0 md:flex-col md:overflow-y-auto md:p-2 md:pt-5 md:pb-2" aria-label="Codex 配置导航">
        <div className="flex gap-1 md:flex-col md:gap-1">
          {navigation.map(([id, label, Icon]) => <Button key={id} type="button" variant="ghost" size="sm" aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)} className={cn('w-full justify-start gap-1.5 py-4 rounded-lg', section === id && 'bg-muted hover:bg-muted dark:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)] dark:hover:bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]')}><Icon className="w-4 h-4" /><span className="text-sm font-normal">{label}</span></Button>)}
        </div>
      </nav>
      <div className="w-full min-w-0">
        <div className="mx-auto w-full max-w-[620px] space-y-4">
          {notice && <Banner icon={Check} text={notice} />}{error && <Banner icon={CircleAlert} text={error} destructive />}
          {loading && !catalog ? <Panel {...sectionMeta[section]}><Loading /></Panel> : catalog && <>
            {section === 'model' && <General form={form} setForm={setForm} models={models} disabled={saving !== null} onSave={() => void save(['model', 'model_reasoning_effort', 'model_verbosity', 'review_model', 'service_tier', 'web_search'])} />}
            {section === 'permissions' && <Security form={form} setForm={setForm} requirements={catalog.requirements} disabled={saving !== null} onSave={() => void save(['approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write.network_access'])} />}
            {section === 'connections' && <Connections mcp={mcp} cwd={notebook.path} projectVersion={projectVersion} saving={saving} run={run} />}
            {section === 'skills' && <Skills skills={skills} cwd={notebook.path} saving={saving} run={run} />}
            {section === 'prompts' && <Panel title="提示词" description="设置当前笔记本项目的默认指令，保存后写入 .codex/config.toml。"><ProjectPromptEditor form={form} setForm={setForm} disabled={saving !== null} onSave={() => void save(['instructions', 'developer_instructions'], true)} /></Panel>}
            {section === 'agents' && <Agents agents={agents} />}
            {section === 'other' && <Other catalog={catalog} installed={installed} available={available} installedIds={installedIds} saving={saving} cwd={notebook.path} run={run} counts={[skills.length, mcp.length, agents.length, installed.length]} />}
          </>}
        </div>
      </div>
    </div>
  </div>;
}

function General({ form, setForm, models, disabled, onSave }: FormProps & { models: JsonObject[] }) {
  const set = (key: string, value: string | boolean) => setForm((x) => ({ ...x, [key]: value }));
  const model = models.find((x) => str(x.model, str(x.id)) === form.model);
  const efforts = arr(model?.supportedReasoningEfforts).map((x) => str(obj(x).reasoningEffort)).filter(Boolean);
  const modelOptions = models.map((x) => { const value = str(x.model, str(x.id)); return { value, label: str(x.displayName, value) }; });
  return <Panel title="模型与运行参数" description="设置写入当前笔记本的 .codex/config.toml。模型和推理设置对新会话生效。">
    <Field label="默认模型"><OptionSelect value={str(form.model)} options={modelOptions} onChange={(v) => set('model', v)} /></Field>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="推理强度"><OptionSelect value={str(form.model_reasoning_effort)} options={options(efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'])} onChange={(v) => set('model_reasoning_effort', v)} /></Field><Field label="输出详细度"><OptionSelect value={str(form.model_verbosity)} options={options(['low', 'medium', 'high'])} onChange={(v) => set('model_verbosity', v)} /></Field></div>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Review 模型"><OptionSelect value={str(form.review_model)} options={[{ value: '', label: '跟随默认模型' }, ...modelOptions]} onChange={(v) => set('review_model', v)} /></Field><Field label="服务级别"><OptionSelect value={str(form.service_tier)} options={options(['auto', 'default', 'flex', 'priority'])} onChange={(v) => set('service_tier', v)} /></Field></div>
    <Field label="联网搜索"><OptionSelect value={str(form.web_search)} options={options(['disabled', 'cached', 'indexed', 'live'])} onChange={(v) => set('web_search', v)} /></Field>
    <Save disabled={disabled} onClick={onSave} />
  </Panel>;
}

function Security({ form, setForm, requirements, disabled, onSave }: FormProps & { requirements: unknown }) {
  const set = (key: string, value: string | boolean) => setForm((x) => ({ ...x, [key]: value }));
  return <Panel title="审批与 Sandbox" description="保存时 Codex 会再次校验组织策略；高优先级策略可以覆盖项目值。">
    {resultValue(requirements).requirements != null && <Banner icon={LockKeyhole} text="已载入 Codex 管理策略约束。" />}
    <div className="grid gap-3 sm:grid-cols-2"><Field label="审批策略"><OptionSelect value={str(form.approval_policy)} options={options(['untrusted', 'on-failure', 'on-request', 'never'])} onChange={(v) => set('approval_policy', v)} /></Field><Field label="审批处理者"><OptionSelect value={str(form.approvals_reviewer)} options={options(['user', 'auto_review'])} onChange={(v) => set('approvals_reviewer', v)} /></Field></div>
    <Field label="Sandbox 模式"><OptionSelect value={str(form.sandbox_mode)} options={options(['read-only', 'workspace-write', 'danger-full-access'])} onChange={(v) => set('sandbox_mode', v)} /></Field>
    <label className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-3"><span><span className="block text-sm font-medium">允许 Sandbox 网络访问</span><span className="mt-0.5 block text-xs text-[var(--muted-foreground)]">仅影响 workspace-write Sandbox。</span></span><input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={bool(form.network_access)} onChange={(e) => set('network_access', e.target.checked)} /></label>
    <Save disabled={disabled} onClick={onSave} />
  </Panel>;
}

type FormProps = { form: Record<string, string | boolean>; setForm: React.Dispatch<React.SetStateAction<Record<string, string | boolean>>>; disabled: boolean; onSave: () => void };
function Connections({ mcp, cwd, projectVersion, saving, run }: { mcp: JsonObject[]; cwd: string; projectVersion: string | null; saving: string | null; run: ActionRunner }) {
  return <Panel title="连接" description="管理当前笔记本项目使用的 MCP Server。">
    <ProjectMcpEditor cwd={cwd} projectVersion={projectVersion} saving={saving} run={run} />
    <div className="flex justify-end"><Button size="sm" variant="outline" className="rounded-lg px-3" disabled={saving !== null} onClick={() => void run('mcp', () => agent.reloadCodexMcp(cwd), 'MCP Server 已重新加载。')}>{saving === 'mcp' ? '重新加载中…' : '重新加载全部'}</Button></div>
    <List items={mcp} empty="当前项目没有配置 MCP Server">{(x) => <Row key={str(x.name)} title={str(x.name)} text={str(obj(x.serverInfo).description, '项目 MCP Server')} meta={str(x.runtimeStatus, str(x.authStatus, '已配置'))} />}</List>
  </Panel>;
}
function Skills({ skills, cwd, saving, run }: { skills: JsonObject[]; cwd: string; saving: string | null; run: ActionRunner }) {
  const getDisplayName = (skill: JsonObject) => displayNameForComposerSkill(
    str(skill.name),
    str(obj(skill.interface).displayName),
  );
  const getShortDescription = (skill: JsonObject) => str(
    obj(skill.interface).shortDescription,
    str(skill.shortDescription, str(skill.description, str(skill.whenToUse))),
  );
  return <Panel title="技能" description="管理当前项目发现的 Skill，也可以创建新的项目 Skill。">
    <ProjectSkillEditor cwd={cwd} saving={saving} run={run} />
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {skills.length ? skills.map((x) => {
        const name = str(x.name);
        const key = `skill:${name}`;
        return <Row
          key={`${name}:${str(x.path)}`}
          title={getDisplayName(x)}
          text={getShortDescription(x)}
          meta={str(x.path)}
          action={<Button size="sm" variant="outline" className="shrink-0 rounded-lg px-3" disabled={saving !== null} onClick={() => void run(key, () => agent.setCodexSkillEnabled(cwd, name, x.enabled === false), x.enabled === false ? 'Skill 已启用。' : 'Skill 已停用。', true)}>{saving === key ? '处理中…' : x.enabled === false ? '启用' : '停用'}</Button>}
        />;
      }) : <div className="py-10 text-center text-sm text-[var(--muted-foreground)] sm:col-span-2">未发现 Skill</div>}
    </div>
  </Panel>;
}
function Agents({ agents }: { agents: JsonObject[] }) {
  return <Panel title="子Agent" description="查看当前笔记本项目配置的子 Agent。">
    <List items={agents} empty="未发现子 Agent">{(x, i) => <Row key={`${str(x.id, str(x.name))}:${i}`} title={str(x.name, str(x.preview, '子 Agent'))} text={str(x.description, str(x.preview))} meta={str(x.model)} />}</List>
  </Panel>;
}
function Other({ catalog, installed, available, installedIds, saving, cwd, run, counts }: { catalog: CodexProjectCapabilities; installed: JsonObject[]; available: JsonObject[]; installedIds: Set<string>; saving: string | null; cwd: string; run: ActionRunner; counts: number[] }) {
  return <div className="space-y-4">
    <Panel title="其他" description="管理 Codex 插件，并查看当前项目的能力概览。">
      <List items={available.length ? available : installed} empty="没有可用插件">{(x, i) => { const id = str(x.id, str(x.name)); const isInstalled = bool(x.installed) || installedIds.has(id) || installedIds.has(str(x.name)); const actionId = isInstalled ? id : str(x.name, id); const key = `plugin:${id}`; return <Row key={`${id}:${i}`} title={str(obj(x.interface).displayName, str(x.name, id))} text={str(x.description, str(obj(x.interface).shortDescription))} meta={str(x.marketplace)} action={<Button size="sm" variant="outline" className="rounded-lg px-3" disabled={saving !== null || !actionId} onClick={() => void run(key, () => agent.setCodexPluginInstalled(cwd, actionId, !isInstalled), isInstalled ? '插件已卸载。' : '插件已安装。', true)}>{saving === key ? '处理中…' : isInstalled ? '卸载' : '安装'}</Button>} />; }}</List>
    </Panel>
    <Overview catalog={catalog} counts={counts} />
  </div>;
}

type ActionRunner = (key: string, action: () => Promise<unknown>, message: string, force?: boolean) => Promise<boolean>;
function ProjectMcpEditor({ cwd, projectVersion, saving, run }: { cwd: string; projectVersion: string | null; saving: string | null; run: ActionRunner }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [endpoint, setEndpoint] = useState('');
  const [args, setArgs] = useState('');
  const submit = () => {
    const definition: Record<string, unknown> = transport === 'stdio'
      ? { command: endpoint.trim(), args: args.split('\n').map((x) => x.trim()).filter(Boolean), enabled: true }
      : { url: endpoint.trim(), enabled: true };
    void run('mcp-write', () => agent.upsertCodexProjectMcp(cwd, name.trim(), definition, projectVersion), '项目 MCP 已保存并重新加载。').then((ok) => { if (ok) setOpen(false); });
  };
  return <div className="rounded-lg border border-dashed border-[var(--divider)] p-3">
    <div className="flex items-center justify-between"><div><div className="text-sm font-medium">添加项目 MCP</div><div className="text-xs text-[var(--muted-foreground)]">写入当前 repo 的 .codex/config.toml。</div></div><Button size="sm" variant="outline" className="rounded-lg px-3" onClick={() => setOpen((x) => !x)}>{open ? '收起' : '添加'}</Button></div>
    {open && <div className="mt-3 space-y-3"><div className="grid gap-3 sm:grid-cols-2"><Field label="名称"><input className={selectClass} value={name} placeholder="例如 docs-search" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} /></Field><Field label="连接方式"><OptionSelect value={transport} options={options(['stdio', 'http'])} onChange={(v) => setTransport(v as 'stdio' | 'http')} /></Field></div><Field label={transport === 'stdio' ? '启动命令' : '服务 URL'}><input className={selectClass} value={endpoint} placeholder={transport === 'stdio' ? '例如 npx' : 'https://example.com/mcp'} onChange={(e) => setEndpoint(e.target.value)} /></Field>{transport === 'stdio' && <Field label="参数（每行一个）"><textarea className="min-h-20 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 font-mono text-xs outline-none focus:border-[var(--primary)]" value={args} placeholder={'-y\n@scope/mcp-server'} onChange={(e) => setArgs(e.target.value)} /></Field>}<div className="flex justify-end"><Button disabled={saving !== null || !name || !endpoint.trim()} onClick={submit}>{saving === 'mcp-write' ? '保存中…' : '保存并加载'}</Button></div></div>}
  </div>;
}

function ProjectSkillEditor({ cwd, saving, run }: { cwd: string; saving: string | null; run: ActionRunner }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const submit = () => void run('skill-write', () => agent.writeCodexProjectSkill(cwd, name, description, instructions), '项目 Skill 已保存。', true).then((ok) => { if (ok) setOpen(false); });
  return <div className="rounded-lg border border-dashed border-[var(--divider)] p-3">
    <div className="flex items-center justify-between"><div><div className="text-sm font-medium">新建项目 Skill</div><div className="text-xs text-[var(--muted-foreground)]">保存在 .agents/skills/&lt;name&gt;/SKILL.md。</div></div><Button size="sm" variant="outline" className="rounded-lg px-3" onClick={() => setOpen((x) => !x)}>{open ? '收起' : '新建'}</Button></div>
    {open && <div className="mt-3 space-y-3"><Field label="名称"><input className={selectClass} value={name} placeholder="lowercase-skill-name" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></Field><Field label="触发说明"><input className={selectClass} value={description} placeholder="说明何时应使用这个 Skill" maxLength={500} onChange={(e) => setDescription(e.target.value)} /></Field><Field label="Skill 指令"><textarea className="min-h-40 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 font-mono text-xs leading-5 outline-none focus:border-[var(--primary)]" value={instructions} placeholder="# 工作流程&#10;&#10;- 第一步……" onChange={(e) => setInstructions(e.target.value)} /></Field><div className="flex justify-end"><Button disabled={saving !== null || !name || !instructions.trim()} onClick={submit}>{saving === 'skill-write' ? '保存中…' : '创建 Skill'}</Button></div></div>}
  </div>;
}

function ProjectPromptEditor({ form, setForm, disabled, onSave }: FormProps) {
  const set = (key: string, value: string) => setForm((x) => ({ ...x, [key]: value }));
  return <div className="space-y-4"><Banner icon={Sparkles} text="Prompt 只写入当前笔记本项目；已有会话可能需要重新创建后才会采用新指令。" /><Field label="项目指令（instructions）"><textarea className="min-h-36 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 text-sm leading-5 outline-none focus:border-[var(--primary)]" value={str(form.instructions)} placeholder="描述项目目标、约束、术语和默认工作方式。" onChange={(e) => set('instructions', e.target.value)} /></Field><Field label="开发者指令（developer_instructions）"><textarea className="min-h-44 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 font-mono text-xs leading-5 outline-none focus:border-[var(--primary)]" value={str(form.developer_instructions)} placeholder="描述代码规范、验证要求、目录边界等开发规则。" onChange={(e) => set('developer_instructions', e.target.value)} /></Field><Save disabled={disabled} onClick={onSave} /></div>;
}

function flattenPlugins(source: JsonObject): JsonObject[] { return arr(source.marketplaces).flatMap((m) => arr(obj(m).plugins).map((p) => ({ ...obj(p), marketplace: str(obj(m).name) }))); }
function Overview({ catalog, counts }: { catalog: CodexProjectCapabilities; counts: number[] }) { const errors = [catalog.config, catalog.models, catalog.requirements, catalog.skills, catalog.mcp, catalog.plugins, catalog.pluginCatalog, catalog.agents].map(resultError).filter(Boolean); return <Panel title="项目能力概览" description={`配置文件：${catalog.projectConfigPath}`}><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Skills', counts[0]], ['MCP', counts[1]], ['子 Agent', counts[2]], ['插件', counts[3]]].map(([label, count]) => <div key={String(label)} className="rounded-lg bg-[var(--muted)]/50 p-3"><div className="text-xl font-semibold">{count}</div><div className="text-xs text-[var(--muted-foreground)]">{label}</div></div>)}</div>{errors.map((x, i) => <Banner key={`${x}:${i}`} icon={CircleAlert} text={x} destructive />)}</Panel>; }
function ProjectHeader({ notebook, notebooks, selectedNotebookId, onNotebookChange }: {
  notebook: Notebook;
  notebooks: Notebook[];
  selectedNotebookId: string;
  onNotebookChange: (id: string) => void;
}) {
  return <div className="py-1">
    <div className="flex items-center gap-3">
      <span className="text-sm font-normal text-[var(--foreground)]">笔记本</span>
      <Select value={selectedNotebookId} onValueChange={onNotebookChange}>
        <SelectTrigger className="w-72">
          <span className="truncate text-left">{notebook.name}</span>
        </SelectTrigger>
        <SelectContent align="start" className="flowix-preferences-select-content w-72">
          {notebooks.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  </div>;
}
function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="space-y-6"><div className="space-y-1 border-b border-[var(--divider)] pb-3"><h3 className="text-base font-medium text-[var(--foreground)]">{title}</h3><p className="text-sm leading-6 text-[var(--muted-foreground)]">{description}</p></div>{children}</section>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block space-y-1.5"><span className="text-xs font-medium">{label}</span>{children}</label>; }
function OptionSelect({ value, options: optionList, onChange }: { value: string; options: SelectOption[]; onChange: (v: string) => void }) {
  const selected = optionList.find((option) => option.value === value);
  return <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="h-8 w-full rounded-lg border-[var(--border)] bg-[var(--card)]">
      <SelectValue>{selected?.label ?? value}</SelectValue>
    </SelectTrigger>
    <SelectContent align="start" fitViewport className="flowix-preferences-select-content">
      {optionList.map((option) => <SelectItem key={option.value || '__default__'} value={option.value}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
function Save({ disabled, onClick }: { disabled: boolean; onClick: () => void }) { return <div className="flex justify-end"><Button disabled={disabled} onClick={onClick}>{disabled ? '保存中…' : '保存到当前项目'}</Button></div>; }
function Row({ title, text, meta, action }: { title: string; text?: string; meta?: string; action?: React.ReactNode }) { return <div className="flex items-start gap-3 rounded-lg border border-[var(--divider)] px-3 py-2.5"><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{title}</div>{text && <div className="mt-0.5 line-clamp-2 text-xs text-[var(--muted-foreground)]">{text}</div>}{meta && <div className="mt-1 truncate font-mono text-[10px] text-[var(--muted-foreground)]">{meta}</div>}</div>{action}</div>; }
function List({ items, empty, children }: { items: JsonObject[]; empty: string; children: (item: JsonObject, index: number) => React.ReactNode }) { return <div className="space-y-2">{items.length ? items.map(children) : <div className="py-10 text-center text-sm text-[var(--muted-foreground)]">{empty}</div>}</div>; }
function Banner({ icon: Icon, text, destructive = false }: { icon: typeof Check; text: string; destructive?: boolean }) { return <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', destructive ? 'border-[color-mix(in_oklch,var(--destructive)_25%,var(--divider))]' : 'border-[var(--divider)]')}><Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', destructive ? 'text-[var(--destructive)]' : 'text-[var(--primary)]')} /><span className="text-[var(--muted-foreground)]">{text}</span></div>; }
function Loading() { return <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--primary)]" /></div>; }
function Empty({ icon: Icon, title, text }: { icon: typeof Sparkles; title: string; text: string }) { return <div className="flex min-h-48 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--divider)] text-center"><Icon className="h-6 w-6 text-[var(--muted-foreground)]" /><div className="mt-3 text-sm font-medium">{title}</div><p className="mt-1 text-xs text-[var(--muted-foreground)]">{text}</p></div>; }
