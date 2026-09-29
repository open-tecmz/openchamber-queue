/**
 * Panel copy in the user's language.
 *
 * OpenChamber hands the guest a BCP-47 tag through `HostReadyContext.locale`
 * on every `onReady` snapshot; the panel picks the closest dictionary and
 * falls back to English. Adding a language is one block in `DICTIONARIES`.
 *
 * Manifest strings (panel name, slash-command description, action label)
 * cannot be localized by the extension API — they stay as declared in
 * `package.json`.
 */

export type Locale = 'en' | 'zh-cn' | 'zh-tw';

export const DEFAULT_LOCALE: Locale = 'en';

const en = {
  title: 'Queue',
  'task.untitled': 'Queue task',
  noProject: 'No project open',
  loading: 'Loading…',
  'mode.backend': 'Background',
  'mode.local': 'Foreground',
  'mode.unknown': 'Connecting',
  'count.pending': '{n} pending',
  'count.completed': '{n} done',
  'banner.local.title': 'Running in the foreground',
  'banner.local.body': 'The local service is unavailable, so the queue only runs while this page is open. Approve the extension local service to keep it working in the background.',
  'banner.error.title': 'Cannot reach the scheduler',
  'banner.error.body': 'Wait a moment or reopen the panel.',
  'empty.noProject.title': 'No project open',
  'empty.noProject.body': 'Open a project in OpenChamber to use the queue.',
  'switch.label': 'Enable queue',
  'switch.on': 'When the project has no running session, a new session is started with the first task.',
  'switch.off': 'Queue stopped. It stops itself when it runs out of tasks.',
  'composer.label': 'New task (the content is the prompt)',
  'composer.placeholder': 'Type what should run…',
  'composer.runNow': 'Run now',
  'composer.add': 'Add to queue',
  'list.empty.title': 'Queue is empty',
  'list.empty.body': 'Add a task above, then turn the switch on.',
  'list.empty.bodyCompleted': '{n} task(s) completed. Add a task and turn the switch on again.',
  'row.clickToEdit': 'click to edit',
  'row.top': 'Top',
  'row.retry': 'Retry',
  'row.delete': 'Delete',
  'edit.save': 'Save',
  'edit.cancel': 'Cancel',
  'footer.clear': 'Clear queue',
  'status.pending': 'Pending',
  'status.failed': 'Failed',
  'toast.locked': 'Queue is running: turn the switch off before editing tasks',
  'toast.enqueued': 'Added to the queue',
  'toast.ranNow': 'Started a new session',
  'toast.noDirectory': 'Could not determine the current project directory',
  'reason.noModel': 'No model available',
  'reason.sendFailed': 'Send failed ({sent})',
  'reason.createFailed': 'Could not create the session',
} as const;

export type MessageKey = keyof typeof en;
type Dictionary = Record<MessageKey, string>;

const zhCn: Dictionary = {
  title: '队列',
  'task.untitled': '队列任务',
  noProject: '未打开项目',
  loading: '加载中…',
  'mode.backend': '后台调度',
  'mode.local': '前台调度',
  'mode.unknown': '连接中',
  'count.pending': '待执行 {n}',
  'count.completed': '已完成 {n}',
  'banner.local.title': '当前为前台调度',
  'banner.local.body': '后台服务不可用，队列仅在页面打开时运行。批准扩展的本地服务后可在后台持续工作。',
  'banner.error.title': '无法连接调度器',
  'banner.error.body': '请稍候或重新打开面板。',
  'empty.noProject.title': '未打开项目',
  'empty.noProject.body': '在 OpenChamber 中打开一个项目后即可使用队列。',
  'switch.label': '启用队列',
  'switch.on': '项目没有正在运行的会话时，自动创建会话并发送队首任务。',
  'switch.off': '队列已停止。任务为空时会自动停止。',
  'composer.label': '新任务（内容即提示词）',
  'composer.placeholder': '输入要执行的内容…',
  'composer.runNow': '立即执行',
  'composer.add': '加入队列',
  'list.empty.title': '队列为空',
  'list.empty.body': '在上方添加任务，然后打开开关。',
  'list.empty.bodyCompleted': '已完成 {n} 个任务。添加新任务后需要重新打开开关。',
  'row.clickToEdit': '点击修改',
  'row.top': '置顶',
  'row.retry': '重试',
  'row.delete': '删除',
  'edit.save': '保存',
  'edit.cancel': '取消',
  'footer.clear': '清空队列',
  'status.pending': '待执行',
  'status.failed': '失败',
  'toast.locked': '队列运行中：请先关闭开关再修改任务',
  'toast.enqueued': '已加入队列',
  'toast.ranNow': '已创建新会话并开始执行',
  'toast.noDirectory': '无法确定当前项目目录',
  'reason.noModel': '没有可用的模型',
  'reason.sendFailed': '发送失败 ({sent})',
  'reason.createFailed': '创建会话失败',
};

const zhTw: Dictionary = {
  title: '佇列',
  'task.untitled': '佇列任務',
  noProject: '未開啟專案',
  loading: '載入中…',
  'mode.backend': '後台調度',
  'mode.local': '前台調度',
  'mode.unknown': '連線中',
  'count.pending': '待執行 {n}',
  'count.completed': '已完成 {n}',
  'banner.local.title': '目前為前台調度',
  'banner.local.body': '後台服務無法使用，佇列僅在頁面開啟時運作。核准擴充功能的在地服務後可在後台持續運作。',
  'banner.error.title': '無法連線調度器',
  'banner.error.body': '請稍候或重新開啟面板。',
  'empty.noProject.title': '未開啟專案',
  'empty.noProject.body': '在 OpenChamber 中開啟一個專案後即可使用佇列。',
  'switch.label': '啟用佇列',
  'switch.on': '專案沒有正在執行的會話時，自動建立會話並送出最前面的任務。',
  'switch.off': '佇列已停止。任務清空時會自動停止。',
  'composer.label': '新任務（內容即提示詞）',
  'composer.placeholder': '輸入要執行的內容…',
  'composer.runNow': '立即執行',
  'composer.add': '加入佇列',
  'list.empty.title': '佇列為空',
  'list.empty.body': '在上方新增任務，然後開啟開關。',
  'list.empty.bodyCompleted': '已完成 {n} 個任務。新增任務後需要重新開啟開關。',
  'row.clickToEdit': '點擊修改',
  'row.top': '置頂',
  'row.retry': '重試',
  'row.delete': '刪除',
  'edit.save': '儲存',
  'edit.cancel': '取消',
  'footer.clear': '清空佇列',
  'status.pending': '待執行',
  'status.failed': '失敗',
  'toast.locked': '佇列執行中：請先關閉開關再修改任務',
  'toast.enqueued': '已加入佇列',
  'toast.ranNow': '已建立新會話並開始執行',
  'toast.noDirectory': '無法判斷目前的專案目錄',
  'reason.noModel': '沒有可用的模型',
  'reason.sendFailed': '送出失敗 ({sent})',
  'reason.createFailed': '建立會話失敗',
};

const DICTIONARIES: Record<Locale, Dictionary> = {
  en,
  'zh-cn': zhCn,
  'zh-tw': zhTw,
};

/** Map an OpenChamber locale tag to the closest dictionary, defaulting to English. */
export const resolveLocale = (tag: string | null | undefined): Locale => {
  const value = (tag ?? '').toLowerCase().replace('_', '-');
  if (value === 'en' || value.startsWith('en-')) return 'en';
  if (value.startsWith('zh')) {
    return /(tw|hk|mo|hant)/.test(value) ? 'zh-tw' : 'zh-cn';
  }
  return DEFAULT_LOCALE;
};

export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

const interpolate = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
};

export const createTranslator = (tag: string | null | undefined): Translator => {
  const dictionary = DICTIONARIES[resolveLocale(tag)];
  return (key, params) => interpolate(dictionary[key] ?? en[key] ?? key, params);
};
