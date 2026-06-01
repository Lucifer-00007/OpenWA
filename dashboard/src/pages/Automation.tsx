import { useMemo, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Edit3,
  FlaskConical,
  Loader2,
  MessageSquare,
  Plus,
  Power,
  Regex,
  Search,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { automationApi, type AutomationRule } from '../services/api';
import {
  useAutomationProvidersQuery,
  useAutomationRunsQuery,
  useAutomationRulesQuery,
  useCreateAutomationRuleMutation,
  useDeleteAutomationRuleMutation,
  useSessionsQuery,
  useToggleAutomationRuleMutation,
  useUpdateAutomationRuleMutation,
} from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import './Automation.css';

type AutomationForm = {
  name: string;
  sessionId: string;
  isActive: boolean;
  mode: 'regex' | 'ai';
  targetScope: TargetScope;
  priority: number;
  cooldownSeconds: number;
  replyDelayMs: number;
  targetsText: string;
  regexPattern: string;
  regexReply: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  userPromptTemplate: string;
  fallbackReply: string;
};

type TargetScope = 'all' | 'all_contacts' | 'all_groups' | 'contacts' | 'groups';
type ExplicitTargetScope = Extract<TargetScope, 'contacts' | 'groups'>;
type ModeFilter = '' | 'regex' | 'ai';
type ActiveFilter = '' | 'active' | 'disabled';

const emptyRule: AutomationForm = {
  name: '',
  sessionId: '',
  isActive: true,
  mode: 'regex',
  targetScope: 'all',
  priority: 100,
  cooldownSeconds: 30,
  replyDelayMs: 0,
  targetsText: '',
  regexPattern: '',
  regexReply: '',
  providerId: '',
  model: '',
  systemPrompt: 'You are a concise WhatsApp assistant.',
  userPromptTemplate: 'Customer message: {{message.text}}\nReply in under 60 words.',
  fallbackReply: '',
};

const targetLabels: Record<AutomationForm['targetScope'], string> = {
  all: 'All messages',
  all_contacts: 'All contacts',
  all_groups: 'All groups',
  contacts: 'Selected contacts',
  groups: 'Selected groups',
};

const targetPlaceholders: Record<ExplicitTargetScope, string> = {
  contacts: '+1 415 555 2671\n+44 7700 900123\n+91 89206 44582',
  groups: '120363000000000000@g.us',
};

const targetHelp: Record<ExplicitTargetScope, string> = {
  contacts:
    'One sender per line. Include the country calling code; WhatsApp @lid IDs from recent runs are also accepted.',
  groups: 'One WhatsApp group chat ID per line, ending with @g.us.',
};

function requiresExplicitTargets(scope: TargetScope): scope is ExplicitTargetScope {
  return scope === 'contacts' || scope === 'groups';
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function titleCase(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function Automation() {
  useDocumentTitle('Automation');
  const toast = useToast();
  const { canWrite } = useRole();
  const { data: sessions = [] } = useSessionsQuery();
  const { data: providers = [] } = useAutomationProvidersQuery();
  const [sessionFilter, setSessionFilter] = useState('');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('');
  const rulesQueryParams = useMemo(
    () => ({
      sessionId: sessionFilter || undefined,
      mode: modeFilter || undefined,
      active: activeFilter === '' ? undefined : activeFilter === 'active',
    }),
    [activeFilter, modeFilter, sessionFilter],
  );
  const { data: rulesResult, isLoading } = useAutomationRulesQuery(rulesQueryParams);
  const { data: runsResult } = useAutomationRunsQuery({ sessionId: sessionFilter || undefined });
  const createMutation = useCreateAutomationRuleMutation();
  const updateMutation = useUpdateAutomationRuleMutation();
  const toggleMutation = useToggleAutomationRuleMutation();
  const deleteMutation = useDeleteAutomationRuleMutation();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [form, setForm] = useState(emptyRule);
  const [testBody, setTestBody] = useState('What is the price?');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const rules = rulesResult?.data || [];
  const runs = runsResult?.data || [];
  const isSavingRule = createMutation.isPending || updateMutation.isPending;
  const sessionNames = useMemo(() => new Map(sessions.map(s => [s.id, s.name])), [sessions]);
  const providerNames = useMemo(() => new Map(providers.map(provider => [provider.id, provider.name])), [providers]);
  const activeRules = rules.filter(rule => rule.isActive).length;
  const regexRules = rules.filter(rule => rule.mode === 'regex').length;
  const aiRules = rules.filter(rule => rule.mode === 'ai').length;
  const hasRequiredTargets =
    !requiresExplicitTargets(form.targetScope) || form.targetsText.split('\n').some(value => value.trim());
  const canSave =
    canWrite &&
    !isSavingRule &&
    form.name.trim().length >= 3 &&
    !!form.sessionId &&
    hasRequiredTargets &&
    (form.mode === 'ai' ? !!form.providerId : !!form.regexPattern.trim() && !!form.regexReply.trim());

  const updateForm = <Key extends keyof AutomationForm>(key: Key, value: AutomationForm[Key]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyRule, sessionId: sessions[0]?.id || '' });
    setTestResult(null);
    setShowModal(true);
  };

  const openEdit = (rule: AutomationRule) => {
    setEditing(rule);
    setForm({
      ...emptyRule,
      name: rule.name,
      sessionId: rule.sessionId,
      isActive: rule.isActive,
      mode: rule.mode,
      targetScope: rule.targetScope,
      priority: rule.priority,
      cooldownSeconds: rule.cooldownSeconds,
      replyDelayMs: rule.replyDelayMs,
      targetsText: rule.targets?.map(t => t.targetValue).join('\n') || '',
      regexPattern: rule.triggers?.[0]?.pattern || '',
      regexReply: rule.triggers?.[0]?.replyText || '',
      providerId: rule.providerId || '',
      model: rule.model || '',
      systemPrompt: rule.systemPrompt || emptyRule.systemPrompt,
      userPromptTemplate: rule.userPromptTemplate || emptyRule.userPromptTemplate,
      fallbackReply: rule.fallbackReply || '',
    });
    setTestResult(null);
    setShowModal(true);
  };

  const buildPayload = () => {
    const targets = !requiresExplicitTargets(form.targetScope)
      ? []
      : form.targetsText
          .split('\n')
          .map(v => v.trim())
          .filter(Boolean)
          .map(targetValue => ({
            targetType: (form.targetScope === 'groups' ? 'group' : 'contact') as 'group' | 'contact',
            targetValue,
          }));

    return {
      sessionId: form.sessionId,
      name: form.name.trim(),
      isActive: form.isActive,
      mode: form.mode,
      targetScope: form.targetScope,
      priority: Number(form.priority),
      cooldownSeconds: Number(form.cooldownSeconds),
      replyDelayMs: Number(form.replyDelayMs),
      targets,
      triggers:
        form.mode === 'regex'
          ? [{ pattern: form.regexPattern.trim(), flags: 'i', replyText: form.regexReply.trim(), sortOrder: 0 }]
          : [],
      providerId: form.mode === 'ai' ? form.providerId : undefined,
      model: form.mode === 'ai' ? form.model.trim() || undefined : undefined,
      systemPrompt: form.mode === 'ai' ? form.systemPrompt : undefined,
      userPromptTemplate: form.mode === 'ai' ? form.userPromptTemplate : undefined,
      fallbackReply: form.mode === 'ai' ? form.fallbackReply.trim() || undefined : undefined,
    };
  };

  const saveRule = async () => {
    if (!canSave) return;
    try {
      const payload = buildPayload();
      if (editing) {
        await updateMutation.mutateAsync({ id: editing.id, data: payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      setShowModal(false);
      toast.success('Automation saved', 'The rule is ready for incoming messages.');
    } catch (err) {
      toast.error('Save failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const toggleRule = async (rule: AutomationRule) => {
    if (!canWrite) return;
    try {
      await toggleMutation.mutateAsync({ id: rule.id, isActive: !rule.isActive });
      toast.success(rule.isActive ? 'Automation disabled' : 'Automation enabled', rule.name);
    } catch (err) {
      toast.error('Update failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const deleteRule = async (rule: AutomationRule) => {
    if (!window.confirm(`Delete automation "${rule.name}"?`)) return;
    try {
      await deleteMutation.mutateAsync(rule.id);
      toast.success('Automation deleted', rule.name);
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const runTest = async () => {
    setIsTesting(true);
    try {
      if (form.mode === 'regex') {
        const regex = new RegExp(form.regexPattern || '(?!)', 'i');
        setTestResult(regex.test(testBody) ? form.regexReply || 'Matched' : 'No match');
        return;
      }

      if (!form.providerId) {
        setTestResult('Select a provider first.');
        return;
      }

      if (editing) {
        const result = await automationApi.testAi(editing.id, { body: testBody });
        setTestResult(result.reply);
        return;
      }

      const result = await automationApi.testProvider(form.providerId, {
        model: form.model.trim() || undefined,
        message: testBody,
      });
      setTestResult(result.sample);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setIsTesting(false);
    }
  };

  const renderRuleSummary = (rule: AutomationRule) => {
    if (rule.mode === 'ai') {
      return providerNames.get(rule.providerId || '') || 'No provider assigned';
    }
    return rule.triggers?.[0]?.pattern || 'No trigger configured';
  };

  return (
    <div className="automation-page">
      <PageHeader
        title="Automation"
        subtitle="Regex and AI replies for incoming WhatsApp messages"
        actions={
          canWrite && (
            <button className="btn-primary automation-new-btn" onClick={openCreate} disabled={sessions.length === 0}>
              <Plus size={18} />
              New Automation
            </button>
          )
        }
      />

      <section className="automation-overview" aria-label="Automation summary">
        <div className="automation-stat">
          <Activity size={18} />
          <span>Total</span>
          <strong>{rulesResult?.total ?? rules.length}</strong>
        </div>
        <div className="automation-stat">
          <CheckCircle2 size={18} />
          <span>Active</span>
          <strong>{activeRules}</strong>
        </div>
        <div className="automation-stat">
          <Regex size={18} />
          <span>Regex</span>
          <strong>{regexRules}</strong>
        </div>
        <div className="automation-stat">
          <Sparkles size={18} />
          <span>AI</span>
          <strong>{aiRules}</strong>
        </div>
      </section>

      <section className="automation-toolbar" aria-label="Automation filters">
        <label className="filter-field">
          <span>Session</span>
          <select value={sessionFilter} onChange={e => setSessionFilter(e.target.value)}>
            <option value="">All sessions</option>
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-field">
          <span>Mode</span>
          <select value={modeFilter} onChange={e => setModeFilter(e.target.value as ModeFilter)}>
            <option value="">All modes</option>
            <option value="regex">Regex</option>
            <option value="ai">AI</option>
          </select>
        </label>
        <label className="filter-field">
          <span>Status</span>
          <select value={activeFilter} onChange={e => setActiveFilter(e.target.value as ActiveFilter)}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </section>

      <div className="automation-content">
        <section className="automation-list-panel">
          <div className="automation-section-header">
            <div>
              <h2>Rules</h2>
              <p>{rules.length} visible</p>
            </div>
            <Search size={18} />
          </div>

          {isLoading ? (
            <div className="automation-loading">
              <Loader2 className="animate-spin" />
            </div>
          ) : rules.length > 0 ? (
            <div className="automation-grid">
              {rules.map(rule => (
                <article className={`automation-card ${rule.isActive ? '' : 'is-disabled'}`} key={rule.id}>
                  <div className="automation-card-header">
                    <div className={`automation-card-icon ${rule.mode}`}>
                      {rule.mode === 'ai' ? <Sparkles size={18} /> : <Regex size={18} />}
                    </div>
                    <div className="automation-card-title">
                      <h3>{rule.name}</h3>
                      <span>{sessionNames.get(rule.sessionId) || rule.sessionId}</span>
                    </div>
                    <span className={`automation-status ${rule.isActive ? 'active' : 'disabled'}`}>
                      {rule.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </div>

                  <p className="automation-rule-summary">{renderRuleSummary(rule)}</p>

                  <div className="automation-meta">
                    <span>
                      <Users size={14} />
                      {targetLabels[rule.targetScope]}
                    </span>
                    <span>
                      <Clock3 size={14} />
                      {rule.cooldownSeconds}s
                    </span>
                    <span>
                      <Activity size={14} />
                      Priority {rule.priority}
                    </span>
                  </div>

                  <div className="automation-actions">
                    <button className="btn-secondary compact" onClick={() => openEdit(rule)}>
                      <Edit3 size={15} />
                      Edit
                    </button>
                    {canWrite && (
                      <>
                        <button
                          className="icon-btn"
                          title={rule.isActive ? 'Disable automation' : 'Enable automation'}
                          onClick={() => toggleRule(rule)}
                          disabled={toggleMutation.isPending}
                        >
                          <Power size={16} />
                        </button>
                        <button className="icon-btn danger" title="Delete automation" onClick={() => deleteRule(rule)}>
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="automation-empty">
              <Bot size={38} />
              <h3>No automations configured</h3>
              <p>Create a rule to start replying automatically.</p>
              {canWrite && sessions.length > 0 && (
                <button className="btn-primary" onClick={openCreate}>
                  <Plus size={16} />
                  New Automation
                </button>
              )}
            </div>
          )}
        </section>

        <aside className="automation-runs">
          <div className="automation-section-header">
            <div>
              <h2>Recent Runs</h2>
              <p>{runs.length} latest</p>
            </div>
            <MessageSquare size={18} />
          </div>
          {runs.length === 0 ? (
            <div className="runs-empty">No automation runs yet.</div>
          ) : (
            <div className="automation-runs-list">
              {runs.map(run => (
                <div key={run.id} className="run-row">
                  <div>
                    <strong>{titleCase(run.status)}</strong>
                    <span>{formatDate(run.createdAt)}</span>
                  </div>
                  <span>{run.chatId}</span>
                  <span>{run.latencyMs ? `${run.latencyMs}ms` : '-'}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {showModal && (
        <div className="modal-overlay automation-overlay" onClick={() => setShowModal(false)}>
          <div className="automation-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="automation-modal-header">
              <div>
                <h2>{editing ? 'Edit Automation' : 'New Automation'}</h2>
                <p>{form.mode === 'ai' ? 'AI generated replies' : 'Regex replies'}</p>
              </div>
              <button className="btn-icon" onClick={() => setShowModal(false)} title="Close">
                <X size={20} />
              </button>
            </div>

            <div className="automation-modal-body">
              <aside className="automation-mode-picker" aria-label="Automation mode">
                <button
                  className={form.mode === 'regex' ? 'selected' : ''}
                  onClick={() => updateForm('mode', 'regex')}
                  type="button"
                >
                  <Regex size={18} />
                  <span>Regex</span>
                </button>
                <button
                  className={form.mode === 'ai' ? 'selected' : ''}
                  onClick={() => updateForm('mode', 'ai')}
                  type="button"
                >
                  <Sparkles size={18} />
                  <span>AI</span>
                </button>
              </aside>

              <div className="automation-form">
                <section className="automation-form-section">
                  <div className="automation-form-heading">
                    <h3>Rule</h3>
                    <label className="automation-switch">
                      <input
                        type="checkbox"
                        checked={form.isActive}
                        onChange={e => updateForm('isActive', e.target.checked)}
                      />
                      <span>{form.isActive ? 'Active' : 'Disabled'}</span>
                    </label>
                  </div>
                  <div className="field-grid field-grid--two">
                    <label className="field">
                      <span>Name</span>
                      <input
                        value={form.name}
                        onChange={e => updateForm('name', e.target.value)}
                        placeholder="Pricing reply"
                      />
                    </label>
                    <label className="field">
                      <span>Session</span>
                      <select value={form.sessionId} onChange={e => updateForm('sessionId', e.target.value)}>
                        <option value="">Select session</option>
                        {sessions.map(session => (
                          <option key={session.id} value={session.id}>
                            {session.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>

                <section className="automation-form-section">
                  <h3>Match</h3>
                  <div className="field-grid field-grid--three">
                    <label className="field">
                      <span>Target</span>
                      <select
                        value={form.targetScope}
                        onChange={e => updateForm('targetScope', e.target.value as AutomationForm['targetScope'])}
                      >
                        <option value="all">All messages</option>
                        <option value="all_contacts">All contacts</option>
                        <option value="all_groups">All groups</option>
                        <option value="contacts">Selected contacts</option>
                        <option value="groups">Selected groups</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Priority</span>
                      <input
                        type="number"
                        min={0}
                        max={1000}
                        value={form.priority}
                        onChange={e => updateForm('priority', Number(e.target.value))}
                      />
                    </label>
                    <label className="field">
                      <span>Cooldown</span>
                      <input
                        type="number"
                        min={0}
                        max={86400}
                        value={form.cooldownSeconds}
                        onChange={e => updateForm('cooldownSeconds', Number(e.target.value))}
                      />
                    </label>
                  </div>
                  {requiresExplicitTargets(form.targetScope) && (
                    <label className="field">
                      <span>Targets</span>
                      <textarea
                        value={form.targetsText}
                        onChange={e => updateForm('targetsText', e.target.value)}
                        placeholder={targetPlaceholders[form.targetScope]}
                      />
                      <small className="field-help">{targetHelp[form.targetScope]}</small>
                    </label>
                  )}
                </section>

                {form.mode === 'regex' ? (
                  <section className="automation-form-section">
                    <h3>Reply</h3>
                    <label className="field">
                      <span>Trigger regex</span>
                      <input
                        value={form.regexPattern}
                        onChange={e => updateForm('regexPattern', e.target.value)}
                        placeholder="\\b(price|cost)\\b"
                      />
                    </label>
                    <label className="field">
                      <span>Reply text</span>
                      <textarea value={form.regexReply} onChange={e => updateForm('regexReply', e.target.value)} />
                    </label>
                  </section>
                ) : (
                  <section className="automation-form-section">
                    <h3>AI Reply</h3>
                    <div className="field-grid field-grid--two">
                      <label className="field">
                        <span>Provider</span>
                        <select value={form.providerId} onChange={e => updateForm('providerId', e.target.value)}>
                          <option value="">Select provider</option>
                          {providers.map(provider => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Model override</span>
                        <input
                          value={form.model}
                          onChange={e => updateForm('model', e.target.value)}
                          placeholder="Optional"
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>System prompt</span>
                      <textarea value={form.systemPrompt} onChange={e => updateForm('systemPrompt', e.target.value)} />
                    </label>
                    <label className="field">
                      <span>User prompt template</span>
                      <textarea
                        value={form.userPromptTemplate}
                        onChange={e => updateForm('userPromptTemplate', e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>Fallback reply</span>
                      <textarea
                        value={form.fallbackReply}
                        onChange={e => updateForm('fallbackReply', e.target.value)}
                      />
                    </label>
                  </section>
                )}

                <section className="automation-test-panel">
                  <label className="field">
                    <span>Test message</span>
                    <div className="automation-test">
                      <input value={testBody} onChange={e => setTestBody(e.target.value)} />
                      <button className="btn-secondary" onClick={runTest} disabled={isTesting} type="button">
                        {isTesting ? <Loader2 className="animate-spin" size={16} /> : <FlaskConical size={16} />}
                        Test
                      </button>
                    </div>
                  </label>
                  {testResult && <div className="automation-test-result">{testResult}</div>}
                </section>
              </div>
            </div>

            <div className="automation-modal-footer">
              <button className="btn-secondary" onClick={() => setShowModal(false)} type="button">
                Cancel
              </button>
              <button className="btn-primary" onClick={saveRule} disabled={!canSave} type="button">
                {isSavingRule && <Loader2 className="animate-spin" size={16} />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
