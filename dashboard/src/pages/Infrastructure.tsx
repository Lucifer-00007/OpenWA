import { useState, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Bot,
  Database,
  Server,
  HardDrive,
  Save,
  ExternalLink,
  Loader2,
  CheckCircle,
  Trash2,
  Globe,
  Webhook,
  Gauge,
} from 'lucide-react';
import { infraApi } from '../services/api';
import { automationApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAutomationProvidersQuery, useInfraStatusQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import './Infrastructure.css';

import sqliteIcon from '../assets/icons/sqlite.svg';
import postgresIcon from '../assets/icons/postgresql.svg';
import folderIcon from '../assets/icons/folder.svg';
import s3Icon from '../assets/icons/s3.svg';

interface DatabaseConfig {
  type: 'sqlite' | 'postgres';
  builtIn: boolean;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  poolSize: number;
  sslEnabled: boolean;
}

interface RedisConfig {
  builtIn: boolean;
  host: string;
  port: string;
  password: string;
  connected: boolean;
}

interface StorageConfig {
  type: 'local' | 's3';
  builtIn: boolean;
  localPath: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Endpoint: string;
}

interface QueueStats {
  pending: number;
  completed: number;
  failed: number;
}

interface ServerConfig {
  port: string;
  nodeEnv: 'production' | 'development';
  domain: string;
  dashboardPort: string;
  baseUrl: string;
  dashboardUrl: string;
  corsOrigins: string;
}

interface WebhookConfig {
  timeout: number;
  maxRetries: number;
  retryDelay: number;
}

interface RateLimitConfig {
  ttl: number;
  max: number;
}

export function Infrastructure() {
  const { t } = useTranslation();
  useDocumentTitle(t('infrastructure.title'));
  const toast = useToast();
  const { data: infraStatus, isLoading: loading } = useInfraStatusQuery();
  const { data: aiProviders = [], refetch: refetchAiProviders } = useAutomationProvidersQuery();
  const [saving, setSaving] = useState(false);
  const [deletingProviderId, setDeletingProviderId] = useState<string | null>(null);
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartStatus, setRestartStatus] = useState<'idle' | 'restarting' | 'waiting' | 'success' | 'error'>('idle');

  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    type: 'sqlite',
    builtIn: false,
    host: 'localhost',
    port: '5432',
    username: 'postgres',
    password: '',
    database: 'openwa',
    poolSize: 10,
    sslEnabled: false,
  });

  const [redisConfig, setRedisConfig] = useState<RedisConfig>({
    builtIn: false,
    host: 'localhost',
    port: '6379',
    password: '',
    connected: false,
  });

  const [storageConfig, setStorageConfig] = useState<StorageConfig>({
    type: 'local',
    builtIn: false,
    localPath: './data/media',
    s3Bucket: '',
    s3Region: 'ap-southeast-1',
    s3AccessKey: '',
    s3SecretKey: '',
    s3Endpoint: '',
  });

  const [queueStats, setQueueStats] = useState({
    messages: { pending: 0, completed: 0, failed: 0 } as QueueStats,
    webhooks: { pending: 0, completed: 0, failed: 0 } as QueueStats,
  });

  const [redisEnabled, setRedisEnabled] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);
  const [pendingProfiles, setPendingProfiles] = useState<string[]>([]);
  const [previousProfiles, setPreviousProfiles] = useState<string[]>([]);

  const [serverConfig, setServerConfig] = useState<ServerConfig>({
    port: '2785',
    nodeEnv: 'development',
    domain: 'localhost',
    dashboardPort: '2886',
    baseUrl: '',
    dashboardUrl: '',
    corsOrigins: '*',
  });

  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>({
    timeout: 10000,
    maxRetries: 3,
    retryDelay: 5000,
  });

  const [rateLimitConfig, setRateLimitConfig] = useState<RateLimitConfig>({
    ttl: 60,
    max: 100,
  });
  const [aiProviderForm, setAiProviderForm] = useState({
    name: '',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    defaultModel: 'gpt-4.1-mini',
    timeoutMs: 15000,
    maxRetries: 1,
  });

  useEffect(() => {
    if (!infraStatus) return;

    setDbConfig(prev => ({
      ...prev,
      type: (infraStatus.database.type as 'sqlite' | 'postgres') || 'sqlite',
      host: infraStatus.database.host || 'localhost',
    }));

    setRedisConfig(prev => ({
      ...prev,
      host: infraStatus.redis.host,
      port: String(infraStatus.redis.port),
      connected: infraStatus.redis.connected,
    }));

    setStorageConfig(prev => ({
      ...prev,
      type: infraStatus.storage.type,
      localPath: infraStatus.storage.path || './uploads',
    }));

    setQueueEnabled(infraStatus.queue.enabled);
    setQueueStats({
      messages: infraStatus.queue.messages,
      webhooks: infraStatus.queue.webhooks,
    });
  }, [infraStatus]);

  if (loading) {
    return (
      <div className="infrastructure-page infra-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  const updateDbConfig = (key: keyof DatabaseConfig, value: string | number | boolean) =>
    setDbConfig(prev => ({ ...prev, [key]: value }));
  const updateRedisConfig = (key: keyof RedisConfig, value: string | boolean) =>
    setRedisConfig(prev => ({ ...prev, [key]: value }));
  const updateStorageConfig = (key: keyof StorageConfig, value: string | boolean) =>
    setStorageConfig(prev => ({ ...prev, [key]: value }));
  const updateServerConfig = (key: keyof ServerConfig, value: string) =>
    setServerConfig(prev => ({ ...prev, [key]: value }));
  const updateWebhookConfig = (key: keyof WebhookConfig, value: number) =>
    setWebhookConfig(prev => ({ ...prev, [key]: value }));
  const updateRateLimitConfig = (key: keyof RateLimitConfig, value: number) =>
    setRateLimitConfig(prev => ({ ...prev, [key]: value }));

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const payload = {
        database: { ...dbConfig },
        redis: { enabled: redisEnabled, ...redisConfig },
        queue: { enabled: queueEnabled },
        storage: { ...storageConfig },
        server: { ...serverConfig },
        webhook: { ...webhookConfig },
        rateLimit: { ...rateLimitConfig },
      };

      const result = await infraApi.saveConfig(payload);
      if (result.saved) {
        setPreviousProfiles(pendingProfiles);
        setPendingProfiles(result.profiles || []);
        setShowRestartModal(true);
      } else {
        toast.error(t('infrastructure.toasts.saveFailed'), result.message);
      }
    } catch (err) {
      toast.error(t('infrastructure.toasts.saveFailed'), err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAiProvider = async () => {
    if (!aiProviderForm.name.trim() || !aiProviderForm.baseUrl.trim() || !aiProviderForm.defaultModel.trim()) return;
    try {
      await automationApi.createProvider({
        ...aiProviderForm,
        name: aiProviderForm.name.trim(),
        baseUrl: aiProviderForm.baseUrl.trim(),
        apiKey: aiProviderForm.apiKey.trim(),
        defaultModel: aiProviderForm.defaultModel.trim(),
      });
      setAiProviderForm({
        name: '',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        defaultModel: 'gpt-4.1-mini',
        timeoutMs: 15000,
        maxRetries: 1,
      });
      await refetchAiProviders();
      toast.success('AI provider saved', 'Automations can now use this provider.');
    } catch (err) {
      toast.error('AI provider failed', err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleDeleteAiProvider = async (id: string, name: string) => {
    if (!window.confirm(`Delete AI provider "${name}"? Automation rules using it will lose their provider assignment.`)) return;
    setDeletingProviderId(id);
    try {
      await automationApi.deleteProvider(id);
      await refetchAiProviders();
      toast.success('AI provider deleted', `${name} was removed.`);
    } catch (err) {
      toast.error('Delete failed', err instanceof Error ? err.message : t('common.unknownError'));
    } finally {
      setDeletingProviderId(null);
    }
  };

  const handleTestAiProvider = async (id: string) => {
    try {
      const result = await automationApi.testProvider(id, { message: 'Reply with ok' });
      toast.success('Provider test passed', `${result.sample} (${result.latencyMs}ms)`);
    } catch (err) {
      toast.error('Provider test failed', err instanceof Error ? err.message : t('common.unknownError'));
    }
  };

  const handleRestart = async () => {
    setRestartStatus('restarting');
    setRestartCountdown(30);

    const profilesToRemove = previousProfiles.filter(p => !pendingProfiles.includes(p));

    try {
      const response = await infraApi.restart(pendingProfiles, profilesToRemove);
      if (response.estimatedTime) setRestartCountdown(response.estimatedTime);
    } catch {
      // Expected — server shutting down
    }

    setRestartStatus('waiting');
    let intervalRef: ReturnType<typeof setInterval> | null = null;
    const stopCountdown = () => {
      if (intervalRef) {
        clearInterval(intervalRef);
        intervalRef = null;
      }
    };

    intervalRef = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    checkServerHealth(stopCountdown);
  };

  const checkServerHealth = async (stopCountdown?: () => void) => {
    let attempts = 0;
    const maxAttempts = 60;

    const check = async () => {
      try {
        await infraApi.healthCheck();
        stopCountdown?.();
        setRestartCountdown(0);
        setRestartStatus('success');
        setTimeout(() => window.location.reload(), 2000);
      } catch {
        attempts++;
        if (attempts < maxAttempts) setTimeout(check, 1000);
        else setRestartStatus('error');
      }
    };

    setTimeout(check, 3000);
  };

  const statusCards = [
    {
      label: t('infrastructure.database.title'),
      value: dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite',
      detail: infraStatus?.database.connected ? t('infrastructure.statusLabels.connected') : t('infrastructure.statusLabels.disconnected'),
      state: infraStatus?.database.connected ? 'good' : 'bad',
      icon: <Database size={18} />,
    },
    {
      label: t('infrastructure.redis.title'),
      value: redisEnabled ? `${redisConfig.host}:${redisConfig.port}` : t('infrastructure.statusLabels.disabled'),
      detail: redisEnabled && redisConfig.connected ? t('infrastructure.statusLabels.connected') : t('infrastructure.statusLabels.disabled'),
      state: redisEnabled && redisConfig.connected ? 'good' : 'muted',
      icon: <Server size={18} />,
    },
    {
      label: t('infrastructure.storage.title'),
      value: storageConfig.type === 's3' ? 'Amazon S3' : 'Local',
      detail: storageConfig.type === 's3' ? storageConfig.s3Bucket || 'S3 bucket' : storageConfig.localPath,
      state: 'good',
      icon: <HardDrive size={18} />,
    },
    {
      label: 'Automation AI',
      value: `${aiProviders.length} provider${aiProviders.length === 1 ? '' : 's'}`,
      detail: `${aiProviders.filter(provider => provider.isActive).length} active`,
      state: aiProviders.some(provider => provider.isActive) ? 'good' : 'muted',
      icon: <Bot size={18} />,
    },
  ];

  return (
    <div className="infrastructure-page">
      <PageHeader title={t('infrastructure.title')} subtitle={t('infrastructure.subtitle')} />

      <section className="infra-status-grid" aria-label="Infrastructure status">
        {statusCards.map(card => (
          <div className={`infra-status-card ${card.state}`} key={card.label}>
            <div className="infra-status-icon">{card.icon}</div>
            <div>
              <span>{card.label}</span>
              <strong>{card.value}</strong>
              <small>{card.detail}</small>
            </div>
          </div>
        ))}
      </section>

      <div className="infra-sections">
        <section className="infra-card infra-card--ai">
          <div className="card-header">
            <div className="header-left">
              <Bot size={20} />
              <h2>AI Providers</h2>
            </div>
          </div>
          <p className="section-description">OpenAI-compatible providers for Automation replies.</p>
          <div className="config-form">
            <div className="form-row">
              <div className="form-group">
                <label>Name</label>
                <input
                  value={aiProviderForm.name}
                  onChange={e => setAiProviderForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="OpenAI"
                />
              </div>
              <div className="form-group">
                <label>Base URL</label>
                <input
                  value={aiProviderForm.baseUrl}
                  onChange={e => setAiProviderForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  value={aiProviderForm.apiKey}
                  onChange={e => setAiProviderForm(prev => ({ ...prev, apiKey: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
              <div className="form-group">
                <label>Default Model</label>
                <input
                  value={aiProviderForm.defaultModel}
                  onChange={e => setAiProviderForm(prev => ({ ...prev, defaultModel: e.target.value }))}
                />
              </div>
            </div>
            <button
              className="btn-primary"
              onClick={handleCreateAiProvider}
              disabled={!aiProviderForm.name.trim() || !aiProviderForm.baseUrl.trim() || !aiProviderForm.defaultModel.trim()}
            >
              Add AI Provider
            </button>
          </div>
          <div className="provider-list">
            {aiProviders.length === 0 ? (
              <div className="infra-inline-empty">No AI providers configured.</div>
            ) : (
              aiProviders.map(provider => (
                <div className="provider-row" key={provider.id}>
                  <div className="provider-main">
                    <strong>{provider.name}</strong>
                    <span className="provider-meta">
                      {provider.baseUrl} · {provider.defaultModel} · {provider.hasApiKey ? 'API key saved' : 'No API key'}
                    </span>
                  </div>
                  <div className="provider-actions">
                    <span className={`status-indicator ${provider.isActive ? 'connected' : 'disconnected'}`}>
                      ● {provider.isActive ? 'Active' : 'Disabled'}
                    </span>
                    <button className="btn-secondary" onClick={() => handleTestAiProvider(provider.id)}>
                      Test
                    </button>
                    <button
                      className="btn-danger-outline provider-delete-btn"
                      onClick={() => handleDeleteAiProvider(provider.id, provider.name)}
                      disabled={deletingProviderId === provider.id}
                      title="Delete provider"
                    >
                      {deletingProviderId === provider.id ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Server Configuration */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Globe size={20} />
              <h2>{t('infrastructure.server.title')}</h2>
            </div>
            <span className={`status-indicator ${serverConfig.nodeEnv === 'production' ? 'connected' : 'sqlite'}`}>
              ● {serverConfig.nodeEnv === 'production' ? t('infrastructure.server.production') : t('infrastructure.server.development')}
            </span>
          </div>

          <div className="config-form">
            <div className="form-row">
              <div className="form-group">
                <label>{t('infrastructure.server.environment')}</label>
                <select
                  value={serverConfig.nodeEnv}
                  onChange={e => updateServerConfig('nodeEnv', e.target.value as 'production' | 'development')}
                >
                  <option value="production">{t('infrastructure.server.production')}</option>
                  <option value="development">{t('infrastructure.server.development')}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('infrastructure.server.domain')}</label>
                <input
                  type="text"
                  value={serverConfig.domain}
                  onChange={e => updateServerConfig('domain', e.target.value)}
                  placeholder="localhost"
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group small">
                <label>{t('infrastructure.server.apiPort')}</label>
                <input type="text" value={serverConfig.port} onChange={e => updateServerConfig('port', e.target.value)} />
              </div>
              <div className="form-group small">
                <label>{t('infrastructure.server.dashboardPort')}</label>
                <input
                  type="text"
                  value={serverConfig.dashboardPort}
                  onChange={e => updateServerConfig('dashboardPort', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('infrastructure.server.corsOrigins')}</label>
                <input
                  type="text"
                  value={serverConfig.corsOrigins}
                  onChange={e => updateServerConfig('corsOrigins', e.target.value)}
                  placeholder={t('infrastructure.server.corsPlaceholder')}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>{t('infrastructure.server.publicApiUrl')}</label>
                <input
                  type="text"
                  value={serverConfig.baseUrl}
                  onChange={e => updateServerConfig('baseUrl', e.target.value)}
                  placeholder="https://api.yourdomain.com"
                />
              </div>
              <div className="form-group">
                <label>{t('infrastructure.server.publicDashboardUrl')}</label>
                <input
                  type="text"
                  value={serverConfig.dashboardUrl}
                  onChange={e => updateServerConfig('dashboardUrl', e.target.value)}
                  placeholder="https://dashboard.yourdomain.com"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Webhook & Rate Limiting */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Webhook size={20} />
              <h2>{t('infrastructure.webhook.title')}</h2>
            </div>
          </div>

          <div className="config-form">
            <h3 className="infra-subsection-title">
              <Webhook size={16} />
              {t('infrastructure.webhook.settings')}
            </h3>
            <div className="form-row">
              <div className="form-group">
                <label>{t('infrastructure.webhook.timeout')}</label>
                <input
                  type="number"
                  value={webhookConfig.timeout}
                  onChange={e => updateWebhookConfig('timeout', parseInt(e.target.value) || 10000)}
                />
              </div>
              <div className="form-group small">
                <label>{t('infrastructure.webhook.maxRetries')}</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={webhookConfig.maxRetries}
                  onChange={e => updateWebhookConfig('maxRetries', parseInt(e.target.value) || 3)}
                />
              </div>
              <div className="form-group">
                <label>{t('infrastructure.webhook.retryDelay')}</label>
                <input
                  type="number"
                  value={webhookConfig.retryDelay}
                  onChange={e => updateWebhookConfig('retryDelay', parseInt(e.target.value) || 5000)}
                />
              </div>
            </div>

            <div className="infra-divider">
              <h3 className="infra-subsection-title">
                <Gauge size={16} />
                {t('infrastructure.webhook.rateLimit')}
              </h3>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('infrastructure.webhook.window')}</label>
                  <input
                    type="number"
                    value={rateLimitConfig.ttl}
                    onChange={e => updateRateLimitConfig('ttl', parseInt(e.target.value) || 60)}
                  />
                </div>
                <div className="form-group">
                  <label>{t('infrastructure.webhook.maxReq')}</label>
                  <input
                    type="number"
                    value={rateLimitConfig.max}
                    onChange={e => updateRateLimitConfig('max', parseInt(e.target.value) || 100)}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Database */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Database size={20} />
              <h2>{t('infrastructure.database.title')}</h2>
            </div>
            <span className={`status-indicator ${dbConfig.type === 'postgres' ? 'connected' : 'sqlite'}`}>
              ● {dbConfig.type === 'postgres' ? 'PostgreSQL' : 'SQLite'}
            </span>
          </div>

          <div className="radio-group">
            <label className={`radio-option ${dbConfig.type === 'sqlite' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={dbConfig.type === 'sqlite'}
                onChange={() => updateDbConfig('type', 'sqlite')}
              />
              <img src={sqliteIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.sqlite')}</span>
              <small>{t('infrastructure.database.sqliteDesc')}</small>
            </label>
            <label className={`radio-option ${dbConfig.type === 'postgres' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="dbType"
                checked={dbConfig.type === 'postgres'}
                onChange={() => updateDbConfig('type', 'postgres')}
              />
              <img src={postgresIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.database.postgres')}</span>
              <small>{t('infrastructure.database.postgresDesc')}</small>
            </label>
          </div>

          {dbConfig.type === 'postgres' && (
            <>
              <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                <div className="toggle-info">
                  <span>{t('infrastructure.database.useBuiltIn')}</span>
                  <small>{t('infrastructure.database.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={dbConfig.builtIn}
                    onChange={e => updateDbConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!dbConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input type="text" value={dbConfig.host} onChange={e => updateDbConfig('host', e.target.value)} />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input type="text" value={dbConfig.port} onChange={e => updateDbConfig('port', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.username')}</label>
                      <input
                        type="text"
                        value={dbConfig.username}
                        onChange={e => updateDbConfig('username', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={dbConfig.password}
                        onChange={e => updateDbConfig('password', e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('infrastructure.database.dbName')}</label>
                      <input
                        type="text"
                        value={dbConfig.database}
                        onChange={e => updateDbConfig('database', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('infrastructure.database.poolSize')}</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={dbConfig.poolSize}
                        onChange={e => updateDbConfig('poolSize', parseInt(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="toggle-row">
                    <div className="toggle-info">
                      <span>{t('infrastructure.database.ssl')}</span>
                      <small>{t('infrastructure.database.sslDesc')}</small>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={dbConfig.sslEnabled}
                        onChange={e => updateDbConfig('sslEnabled', e.target.checked)}
                      />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>
                </div>
              )}
            </>
          )}

          <div
            className="empty-state-card"
          >
            <Database size={32} />
            <p className="empty-state-title">
              {t('infrastructure.database.migrationsTitle')}
            </p>
            <p className="empty-state-success">
              <CheckCircle size={16} />
              {t('infrastructure.database.migrationsStatus')}
            </p>
            <p className="empty-state-copy">
              {t('infrastructure.database.migrationsHint')}
            </p>
          </div>
        </section>

        {/* Redis */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <Server size={20} />
              <h2>{t('infrastructure.redis.title')}</h2>
            </div>
            <span
              className={`status-indicator ${redisEnabled && redisConfig.connected ? 'connected' : 'disconnected'}`}
            >
              ● {redisEnabled
                ? redisConfig.connected
                  ? t('infrastructure.statusLabels.connected')
                  : t('infrastructure.statusLabels.disconnected')
                : t('infrastructure.statusLabels.disabled')}
            </span>
          </div>

          <div
            className={`toggle-row redis-enable-row ${redisEnabled ? 'is-enabled' : ''}`}
          >
            <div className="toggle-info">
              <span>{t('infrastructure.redis.enable')}</span>
              <small>{t('infrastructure.redis.enableDesc')}</small>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={redisEnabled}
                onChange={e => {
                  setRedisEnabled(e.target.checked);
                  if (!e.target.checked) setQueueEnabled(false);
                }}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {redisEnabled ? (
            <>
              <div className="toggle-row" style={{ marginBottom: '1rem' }}>
                <div className="toggle-info">
                  <span>{t('infrastructure.redis.useBuiltIn')}</span>
                  <small>{t('infrastructure.redis.builtInDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={redisConfig.builtIn}
                    onChange={e => updateRedisConfig('builtIn', e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {!redisConfig.builtIn && (
                <div className="config-form">
                  <div className="form-row">
                    <div className="form-group">
                      <label>{t('common.host')}</label>
                      <input
                        type="text"
                        value={redisConfig.host}
                        onChange={e => updateRedisConfig('host', e.target.value)}
                      />
                    </div>
                    <div className="form-group small">
                      <label>{t('common.port')}</label>
                      <input
                        type="text"
                        value={redisConfig.port}
                        onChange={e => updateRedisConfig('port', e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('common.password')}</label>
                      <input
                        type="password"
                        value={redisConfig.password}
                        onChange={e => updateRedisConfig('password', e.target.value)}
                        placeholder={t('infrastructure.redis.passwordOptional')}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div
                className="toggle-row"
                style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem', marginTop: '0.5rem' }}
              >
                <div className="toggle-info">
                  <span>{t('infrastructure.redis.queueTitle')}</span>
                  <small>{t('infrastructure.redis.queueDesc')}</small>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={queueEnabled} onChange={e => setQueueEnabled(e.target.checked)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {queueEnabled && (
                <div className="queue-stats">
                  <h3>{t('infrastructure.redis.statsTitle')}</h3>
                  <div className="stats-row">
                    <div className="queue-stat-card">
                      <h4>{t('infrastructure.redis.messageQueue')}</h4>
                      <div className="stat-values">
                        <div className="stat-item pending">
                          <span className="value">{queueStats.messages.pending}</span>
                          <span className="label">{t('infrastructure.redis.pending')}</span>
                        </div>
                        <div className="stat-item completed">
                          <span className="value">{queueStats.messages.completed.toLocaleString()}</span>
                          <span className="label">{t('infrastructure.redis.completed')}</span>
                        </div>
                        <div className="stat-item failed">
                          <span className="value">{queueStats.messages.failed}</span>
                          <span className="label">{t('infrastructure.redis.failed')}</span>
                        </div>
                      </div>
                    </div>
                    <div className="queue-stat-card">
                      <h4>{t('infrastructure.redis.webhookQueue')}</h4>
                      <div className="stat-values">
                        <div className="stat-item pending">
                          <span className="value">{queueStats.webhooks.pending}</span>
                          <span className="label">{t('infrastructure.redis.pending')}</span>
                        </div>
                        <div className="stat-item completed">
                          <span className="value">{queueStats.webhooks.completed.toLocaleString()}</span>
                          <span className="label">{t('infrastructure.redis.completed')}</span>
                        </div>
                        <div className="stat-item failed">
                          <span className="value">{queueStats.webhooks.failed}</span>
                          <span className="label">{t('infrastructure.redis.failed')}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="queue-actions">
                    <button className="btn-danger-outline">
                      <Trash2 size={16} />
                      {t('infrastructure.redis.clearFailed')}
                    </button>
                    <button
                      className="btn-outline"
                      onClick={() => window.open('http://localhost:2785/api/admin/queues', '_blank')}
                    >
                      <ExternalLink size={16} />
                      {t('infrastructure.redis.viewBullMq')}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state-card is-muted">
              <Server size={32} />
              <p className="empty-state-title">
                {t('infrastructure.redis.disabledTitle')}
              </p>
              <p className="empty-state-copy">
                {t('infrastructure.redis.disabledDesc')}
              </p>
            </div>
          )}
        </section>

        {/* Storage */}
        <section className="infra-card">
          <div className="card-header">
            <div className="header-left">
              <HardDrive size={20} />
              <h2>{t('infrastructure.storage.title')}</h2>
            </div>
          </div>

          <div className="radio-group">
            <label className={`radio-option ${storageConfig.type === 'local' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={storageConfig.type === 'local'}
                onChange={() => updateStorageConfig('type', 'local')}
              />
              <img src={folderIcon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.local')}</span>
              <small>{t('infrastructure.storage.localDesc')}</small>
            </label>
            <label className={`radio-option ${storageConfig.type === 's3' ? 'selected' : ''}`}>
              <input
                type="radio"
                name="storageType"
                checked={storageConfig.type === 's3'}
                onChange={() => updateStorageConfig('type', 's3')}
              />
              <img src={s3Icon} alt="" className="watermark-icon" />
              <span>{t('infrastructure.storage.s3')}</span>
              <small>{t('infrastructure.storage.s3Desc')}</small>
            </label>
          </div>

          <div className="config-form">
            {storageConfig.type === 'local' && (
              <div className="form-group">
                <label>{t('infrastructure.storage.storagePath')}</label>
                <input
                  type="text"
                  value={storageConfig.localPath}
                  onChange={e => updateStorageConfig('localPath', e.target.value)}
                />
              </div>
            )}

            {storageConfig.type === 's3' && (
              <>
                <div className="toggle-row" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
                  <div className="toggle-info">
                    <span>{t('infrastructure.storage.useBuiltIn')}</span>
                    <small>{t('infrastructure.storage.builtInDesc')}</small>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={storageConfig.builtIn}
                      onChange={e => updateStorageConfig('builtIn', e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {!storageConfig.builtIn && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.bucket')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3Bucket}
                          onChange={e => updateStorageConfig('s3Bucket', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.region')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3Region}
                          onChange={e => updateStorageConfig('s3Region', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label>{t('infrastructure.storage.accessKey')}</label>
                        <input
                          type="text"
                          value={storageConfig.s3AccessKey}
                          onChange={e => updateStorageConfig('s3AccessKey', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label>{t('infrastructure.storage.secretKey')}</label>
                        <input
                          type="password"
                          value={storageConfig.s3SecretKey}
                          onChange={e => updateStorageConfig('s3SecretKey', e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>{t('infrastructure.storage.endpoint')}</label>
                      <input
                        type="text"
                        value={storageConfig.s3Endpoint}
                        onChange={e => updateStorageConfig('s3Endpoint', e.target.value)}
                        placeholder={t('infrastructure.storage.endpointHint')}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      {showRestartModal && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: '500px', textAlign: 'center' }}>
            <div className="modal-header" style={{ justifyContent: 'center', borderBottom: 'none' }}>
              <h2>
                {restartStatus === 'idle' && t('infrastructure.restart.idleTitle')}
                {restartStatus === 'restarting' && t('infrastructure.restart.restartingTitle')}
                {restartStatus === 'waiting' && t('infrastructure.restart.waitingTitle')}
                {restartStatus === 'success' && t('infrastructure.restart.successTitle')}
                {restartStatus === 'error' && t('infrastructure.restart.errorTitle')}
              </h2>
            </div>
            <div className="modal-body" style={{ padding: '2rem' }}>
              {restartStatus === 'idle' && (
                <>
                  <p style={{ fontSize: '1rem', color: '#475569', marginBottom: '1.5rem' }}>
                    <Trans i18nKey="infrastructure.restart.idleDesc" components={{ code: <code />, br: <br /> }} />
                  </p>
                  <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
                    <button className="btn-secondary" onClick={() => setShowRestartModal(false)}>
                      {t('infrastructure.restart.later')}
                    </button>
                    <button className="btn-primary" onClick={handleRestart}>
                      {t('infrastructure.restart.now')}
                    </button>
                  </div>
                </>
              )}

              {(restartStatus === 'restarting' || restartStatus === 'waiting') && (
                <>
                  <div style={{ marginBottom: '1.5rem' }}>
                    <Loader2 className="animate-spin" size={48} style={{ color: '#22C55E', marginBottom: '1rem' }} />
                    <p style={{ fontSize: '1.125rem', color: '#1E293B', fontWeight: 500 }}>
                      {restartCountdown > 0
                        ? t('infrastructure.restart.restartingMsg', { count: restartCountdown })
                        : t('infrastructure.restart.checking')}
                    </p>
                  </div>
                  <div
                    style={{
                      width: '100%',
                      height: '8px',
                      background: '#E2E8F0',
                      borderRadius: '4px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: restartCountdown > 0 ? `${((30 - restartCountdown) / 30) * 100}%` : '100%',
                        height: '100%',
                        background: 'linear-gradient(90deg, #22C55E, #10B981)',
                        transition: 'width 1s linear',
                      }}
                    />
                  </div>
                  <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#64748B' }}>
                    {t('infrastructure.restart.dontClose')}
                  </p>
                </>
              )}

              {restartStatus === 'success' && (
                <>
                  <CheckCircle size={48} style={{ color: '#22C55E', marginBottom: '1rem' }} />
                  <p style={{ fontSize: '1rem', color: '#475569' }}>
                    {t('infrastructure.restart.successMsg')}
                  </p>
                </>
              )}

              {restartStatus === 'error' && (
                <>
                  <p style={{ fontSize: '1rem', color: '#DC2626', marginBottom: '1rem' }}>
                    {t('infrastructure.restart.errorMsg')}
                  </p>
                  <button className="btn-primary" onClick={() => window.location.reload()}>
                    {t('infrastructure.restart.reload')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <footer className="page-footer">
        <button className="btn-primary large" onClick={handleSaveConfig} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" size={20} /> : <Save size={20} />}
          {saving ? t('infrastructure.saving') : t('infrastructure.saveConfig')}
        </button>
      </footer>
    </div>
  );
}
