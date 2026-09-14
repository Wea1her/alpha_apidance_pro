/**
 * 领域契约：原因码、事件与判定记录、项目与任务状态。
 *
 * 依据：docs/architecture/frontend-migration.md 第 5 节数据模型、第 12 节 Q38（reasonCode 全集）、
 * Q132-Q136（项目只有“监控中/已排除”两态）、Q119/Q123（CA 链标识 + 严格校验）。
 *
 * 约束：
 * - 本目录只放纯数据契约与校验，不引用服务端配置实现、不读取环境变量、不持有凭证。
 * - 原因码必须覆盖旧实现 src/service.ts 判定链上的每一个提前返回点，否则页面无法解释“为什么没推”。
 */

/** 判定链的原因码全集。顺序大致对应旧实现 processAlphaMessage 的执行顺序。 */
export const REASON_CODES = [
  // —— 采集与解析 ——
  'PARSE_ERROR',
  'HEARTBEAT',
  'COUNT_MISSING',
  'BELOW_THRESHOLD',
  'DEDUPE_REPEAT',
  'IN_FLIGHT',
  'STAR_NOT_INCREASED',
  // —— 账号分类 ——
  'CLASSIFY_BLOCKED',
  'CLASSIFY_ALLOWED',
  'CLASSIFY_ERROR_ALLOWED',
  // —— 推送与投递 ——
  'PUSHED',
  'SEND_FAILED',
  // —— 任务与报告 ——
  'ANALYSIS_QUEUED',
  'ANALYSIS_GENERATED',
  'DEEP_QUEUED',
  'DEEP_GENERATED',
  // —— 依赖等待与投递结果 ——
  'DEPENDENCY_WAIT',
  'DELIVERY_PENDING',
  'DELIVERY_SENT',
  'DELIVERY_FAILED',
  'DELIVERY_UNCERTAIN',
  // —— 监控池状态 ——
  'EXCLUDED_BY_CLASSIFICATION',
  'EXCLUDED_MANUALLY',
  'RESTORED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set<string>(REASON_CODES);

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && REASON_CODE_SET.has(value);
}

/**
 * 原因码的中文说明。页面直接使用，避免在前端重复维护一份文案。
 */
export const REASON_CODE_LABELS: Readonly<Record<ReasonCode, string>> = {
  PARSE_ERROR: '消息无法解析',
  HEARTBEAT: '连接心跳',
  COUNT_MISSING: '未识别到共同关注数',
  BELOW_THRESHOLD: '未达到推送门槛',
  DEDUPE_REPEAT: '重复事件已跳过',
  IN_FLIGHT: '同一事件正在处理中',
  STAR_NOT_INCREASED: '项目星级未升高',
  CLASSIFY_BLOCKED: '账号分类拦截',
  CLASSIFY_ALLOWED: '账号分类放行',
  CLASSIFY_ERROR_ALLOWED: '分类异常后保守放行',
  PUSHED: '已推送到频道',
  SEND_FAILED: '频道推送失败',
  ANALYSIS_QUEUED: '标准分析已排队',
  ANALYSIS_GENERATED: '标准分析已生成',
  DEEP_QUEUED: '深度分析已排队',
  DEEP_GENERATED: '深度分析已生成',
  DEPENDENCY_WAIT: '等待依赖（讨论映射等）',
  DELIVERY_PENDING: '投递待完成',
  DELIVERY_SENT: '投递已确认',
  DELIVERY_FAILED: '投递失败',
  DELIVERY_UNCERTAIN: '投递结果不确定',
  EXCLUDED_BY_CLASSIFICATION: '依据分类结果排除',
  EXCLUDED_MANUALLY: '人工移入排除池',
  RESTORED: '从排除池恢复',
};

/** 会改变项目在监控池中状态的码。 */
export const POOL_STATE_REASON_CODES: readonly ReasonCode[] = [
  'EXCLUDED_BY_CLASSIFICATION',
  'EXCLUDED_MANUALLY',
  'RESTORED',
];

/** 账号分类结果类型。与 src/account-classifier.ts 的 AccountClassificationType 保持一致。 */
export const ACCOUNT_CLASSIFICATION_TYPES = [
  'PROJECT',
  'ALPHA',
  'KOL',
  'PERSONAL',
  'DEV',
  'MEDIA',
  'UNKNOWN',
] as const;

export type AccountClassificationType = (typeof ACCOUNT_CLASSIFICATION_TYPES)[number];

export const ACCOUNT_CLASSIFICATION_TYPE_LABELS: Readonly<Record<AccountClassificationType, string>> = {
  PROJECT: '项目方',
  ALPHA: 'Alpha 信息源',
  KOL: 'KOL',
  PERSONAL: '个人账号',
  DEV: '开发者',
  MEDIA: '媒体',
  UNKNOWN: '未知类型',
};

/** 项目在监控池中的状态。Q132：只有两态，不再有独立的“已停止监控”。 */
export const PROJECT_POOL_STATES = ['monitored', 'excluded'] as const;
export type ProjectPoolState = (typeof PROJECT_POOL_STATES)[number];

/** 项目进入监控池的来源。Q125：手动加入已取消。 */
export const PROJECT_SOURCES = ['natural', 'restored', 'history_import'] as const;
export type ProjectSource = (typeof PROJECT_SOURCES)[number];

/** 项目被排除的原因。Q134：规则拦截与人工排除必须可区分。 */
export const EXCLUSION_REASONS = ['classification', 'manual'] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** 任务类型。 */
export const JOB_KINDS = ['classification', 'standard', 'deep', 'delivery'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** 任务阶段。用于页面展示持久化进度，不允许编造百分比。 */
export const JOB_STAGES = ['queued', 'waiting_dependency', 'running', 'succeeded', 'failed', 'dead_letter'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

/** 接收记录：每次收到的原始输入都保留，包含重复与解析失败。 */
export interface InboundEventRecord {
  /** 平台内部事件 ID（由存储层生成，非上游 ID；上游没有消息 ID）。 */
  eventId: string;
  /** 采集器实例标识；同一时刻只允许一个激活采集器。 */
  collectorId: string;
  /** 接收顺序（单调递增），用于同秒事件的次序仲裁。 */
  ingestSeq: number;
  /** 本地接收时间（ISO，毫秒精度）。 */
  receivedAt: string;
  /** 上游事件时间（秒级，UTC 秒）；缺失时为 null，不得用本地时间顶替。 */
  upstreamPushAtSec: number | null;
  /** 原始 payload 原文，用于重算身份与排查。 */
  rawPayload: string;
  channel: string | null;
  title: string | null;
  link: string | null;
  content: string | null;
  /** 解析出的共同关注数；未识别为 null。 */
  commonFollowCount: number | null;
  /** 旧实现去重键原文，保留用于跨系统对比（Q31）。 */
  legacyDedupeKey: string | null;
  /** 解析失败时记录原因，事件仍然保留。 */
  parseError: string | null;
}

/** 项目来源与状态。 */
export interface ProjectRecord {
  projectId: string;
  /** 归一化账号键（优先 X handle，其次整条链接，最后标题）。 */
  projectKey: string;
  displayName: string | null;
  link: string | null;
  source: ProjectSource;
  poolState: ProjectPoolState;
  /** 当前星级（0 表示尚未达到任何门槛）。 */
  star: number;
  /** 频道展示序号；与真实发送次数是两回事（Q96）。 */
  displayPushCount: number;
  /** 真实发送次数，只统计已确认回执的投递。 */
  confirmedSendCount: number;
  /** 首次真实事件时间（来自上游 push_at），历史数据缺失时为 null。 */
  firstEventAt: string | null;
  /** 最近真实事件时间，历史数据缺失时为 null。 */
  lastEventAt: string | null;
  /** 进入监控池的时间。 */
  enteredPoolAt: string;
  /** 被排除的时间；未排除为 null。 */
  excludedAt: string | null;
  exclusionReason: ExclusionReason | null;
  /** 被排除时的星级，用于排除列表展示（Q134）。 */
  excludedStar: number | null;
  /** 被排除时累计的事件数（Q134）。 */
  excludedEventCount: number | null;
  /** 人工排除的恢复理由；规则拦截的恢复可为 null（Q136）。 */
  restoreReason: string | null;
}

/** CA 合约地址。链未知时只保留原文片段，不建地址字段（Q123）。 */
export interface ContractAddressRecord {
  chain: string;
  address: string;
}

/** CA 提取结果：严格校验通过才有 address。 */
export interface ContractAddressExtraction {
  /** 校验通过的地址；null 表示未通过校验。 */
  contractAddress: ContractAddressRecord | null;
  /** 报告中出现的地址原文片段，供人工判断（Q119）。 */
  rawSnippet: string | null;
  /** 未通过校验的原因；通过时为 null。 */
  rejection: ContractAddressRejection | null;
}

export const CONTRACT_ADDRESS_REJECTIONS = [
  'no_candidate',
  'unknown_chain',
  'bad_format',
  'bad_checksum',
  'ambiguous',
] as const;
export type ContractAddressRejection = (typeof CONTRACT_ADDRESS_REJECTIONS)[number];

/** 配置版本快照：只含非敏感字段（第 7 节要求按白名单返回）。 */
export interface ConfigVersionSnapshot {
  starLevels: number[];
  maxStar: number;
  classificationModel: string | null;
  standardModel: string | null;
  deepModel: string | null;
  searchTools: string[];
  deepSearchTools: string[];
  classificationConcurrency: number;
  standardConcurrency: number;
  deepConcurrency: number;
  requestTimeoutMs: {
    classification: number;
    standard: number;
    deep: number;
  };
  analysisMaxAttempts: number;
  deepAnalysisMaxAttempts: number;
  telegramRetryAttempts: number;
}

export interface ConfigVersionRecord {
  configVersionId: string;
  /** 内容哈希；同一配置重复计算必须稳定。 */
  hash: string;
  /** 生效时间（ISO）。 */
  effectiveAt: string;
  snapshot: ConfigVersionSnapshot;
}

/** 判定记录：每条接收记录最多一条判定（未判定则不存在）。 */
export interface DecisionRecord {
  decisionId: string;
  eventId: string;
  projectId: string | null;
  projectKey: string | null;
  reasonCode: ReasonCode;
  /** 判定时间（ISO）。 */
  decidedAt: string;
  /** 当时生效的配置版本；早期数据缺失为 null。 */
  configVersionId: string | null;
  star: number | null;
  previousStar: number | null;
  maxStar: number | null;
  count: number | null;
  starLevels: number[] | null;
  isRepeat: boolean;
  inFlight: boolean;
  classification: AccountClassificationRecord | null;
}

/** 分类结论。分类失败保守放行时 type/confidence/reason 为 null（Q38）。 */
export interface AccountClassificationRecord {
  type: AccountClassificationType | null;
  confidence: number | null;
  reason: string | null;
  model: string | null;
  /** 分类调用失败时的错误信息；成功为 null。 */
  error: string | null;
}

export interface StandardAnalysisRecord {
  kind: 'standard';
  reportId: string;
  jobId: string;
  projectId: string;
  triggerEventId: string | null;
  model: string | null;
  promptVersion: string | null;
  body: string;
  generatedAt: string;
  usage: ModelUsage | null;
}

export interface DeepAnalysisRecord {
  kind: 'deep';
  reportId: string;
  jobId: string;
  projectId: string;
  /** 固定引用首次通过规则的 5 星事件，后续事件不能替换。 */
  triggerEventId: string | null;
  /** 主消息投递意图；Telegram 恢复后才有实际消息 ID。 */
  mainDeliveryIntentId: string | null;
  model: string | null;
  promptVersion: string | null;
  body: string;
  generatedAt: string;
  usage: ModelUsage | null;
}

export type AnalysisReportRecord = StandardAnalysisRecord | DeepAnalysisRecord;

/** 模型用量；供应商未提供时字段为 null，不能填 0 冒充（第 8 节）。 */
export interface ModelUsage {
  responseId: string | null;
  reportedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  serverSideToolCalls: number | null;
}

/**
 * 投递意图：报告生成与外部投递彻底分离（Q55-D）。
 * 手动触发等无 Telegram 投递的场景，天然不产生投递记录。
 */
export interface DeliveryRecord {
  deliveryId: string;
  projectId: string;
  reportId: string | null;
  /** 业务目的：频道主消息或讨论群报告。 */
  purpose: 'channel_main' | 'discussion_report' | 'discussion_thread';
  targetChatId: string | null;
  targetThreadMessageId: number | null;
  /** 分片号；单条消息为 0。 */
  shardIndex: number;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  messageId: number | null;
  sentAt: string | null;
  /** 结果不确定：远端可能已收到但本地未确认（Q9）。 */
  uncertain: boolean;
}

/** 任务记录。 */
export interface JobRecord {
  jobId: string;
  kind: JobKind;
  projectId: string | null;
  triggerEventId: string | null;
  stage: JobStage;
  attempts: number;
  /** 执行代次：写结果时必须校验，防止过期执行者覆盖新结果。 */
  leaseGeneration: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** 任务的优先级来源；恢复任务优先但最多占 1 个并发槽（Q130、Q131）。 */
  triggeredBy: 'natural' | 'restore';
}

/** 审计条目：不记录任何操作者身份字段（Q75、Q85）。 */
export interface AuditRecord {
  auditId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  beforeSummary: string | null;
  afterSummary: string | null;
  occurredAt: string;
}

export interface ProjectStateTransition {
  from: ProjectPoolState;
  to: ProjectPoolState;
  reasonCode: ReasonCode;
  at: string;
}

/**
 * 纯函数：计算恢复后的项目状态，供任务生成与页面共用。
 * 恢复不绕过推送阈值：只把状态置回 monitored，是否推送仍由后续自然事件决定。
 */
export function planRestoreTransition(
  current: ProjectPoolState,
  at: string,
  restoreReason: string | null
): { transition: ProjectStateTransition; requiresReason: boolean } | { error: 'not_excluded' | 'reason_required' } {
  if (current !== 'excluded') {
    return { error: 'not_excluded' };
  }
  const requiresReason = restoreReason !== null;
  return {
    transition: { from: 'excluded', to: 'monitored', reasonCode: 'RESTORED', at },
    requiresReason,
  };
}
