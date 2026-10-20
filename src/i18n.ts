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
  'mode.unknown': 'Connecting',
  'count.pending': '{n} pending',
  'count.completed': '{n} done',
  'banner.error.title': 'Connecting to the scheduler',
  'banner.error.body': 'The local service is starting. The queue resumes automatically once it is reachable; if it stays like this, approve the local service in Settings → Extensions.',
  'empty.noProject.title': 'No project open',
  'empty.noProject.body': 'Open a project in OpenChamber to use the queue.',
  'switch.label': 'Enable queue',
  'switch.on': 'When the project has been idle for {delay}, a new session is started with the first enabled task. After a task ends on a question, the wait becomes {question}.',
  'switch.off': 'Queue stopped. It stops itself when it runs out of tasks.',
  'settings.title': 'Dispatch settings',
  'settings.summary': '{dispatch} idle · {question} after a question',
  'settings.dispatch': 'Idle wait (seconds)',
  'settings.question': 'After a question (seconds)',
  'settings.range': '1–86400 seconds',
  'settings.invalid': 'Enter a number of seconds between 1 and 86400',
  'settings.idle': 'A session holds the queue while it is:',
  'settings.idleQuestion': 'Waiting on a question',
  'settings.idlePermission': 'Waiting for permission',
  'settings.idleBackground': 'Running a background command',
  'settings.idleOther': 'Another session is active',
  'settings.seconds': '{n} s',
  'settings.minutes': '{n} min',
  'settings.saved': 'Dispatch settings saved',
  'settings.saveFailed': 'Could not save the dispatch settings ({reason})',
  'composer.label': 'New task (the content is the prompt)',
  'composer.enabled': 'Enabled',
  'composer.placeholder': 'Type what should run…',
  'composer.runNow': 'Run now',
  'composer.add': 'Add to queue',
  'composer.append': 'Append to session',
  'composer.image.add': 'Add image',
  'composer.image.uploading': 'Uploading…',
  'composer.image.remove': 'Remove image',
  'composer.image.count': '{n} image(s)',
  'composer.image.untitled': 'image',
  'composer.image.tooMany': 'At most {n} images per task',
  'composer.image.tooLarge': 'Image is too large (max {max})',
  'composer.image.failed': 'Could not attach the image',
  'composer.image.wait': 'Wait for the image to finish uploading',
  'list.empty.title': 'Queue is empty',
  'list.empty.body': 'Add a task above, then turn the switch on.',
  'list.empty.bodyCompleted': '{n} task(s) completed. Add a task and turn the switch on again.',
  'row.clickToEdit': 'click to edit',
  'row.top': 'Top',
  'row.run': 'Run',
  'row.retry': 'Retry',
  'row.delete': 'Delete',
  'row.appendTo': 'Append to {name}',
  'row.enabled': 'Enabled',
  'edit.save': 'Save',
  'edit.cancel': 'Cancel',
  'status.pending': 'Pending',
  'status.failed': 'Failed',
  'status.disabled': 'Disabled',
  'toast.locked': 'Queue is running: turn the switch off before editing tasks',
  'toast.enqueued': 'Added to the queue',
  'toast.ranNow': 'Started a new session',
  'toast.noSession': 'No session is open to append to',
  'toast.noDirectory': 'Could not determine the current project directory',
  'toast.noService': 'The queue service is not available. Open the Queue panel once to start it.',
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
  'mode.unknown': '连接中',
  'count.pending': '待执行 {n}',
  'count.completed': '已完成 {n}',
  'banner.error.title': '正在连接调度服务',
  'banner.error.body': '本地服务正在启动，连接成功后队列会自动恢复；若一直如此，请在「设置 → 扩展」中批准该扩展的本地服务。',
  'empty.noProject.title': '未打开项目',
  'empty.noProject.body': '在 OpenChamber 中打开一个项目后即可使用队列。',
  'switch.label': '启用队列',
  'switch.on': '项目连续空闲 {delay} 后，自动创建会话并发送队首启用中的任务；若上一个任务停在提问上，改为等待 {question}。',
  'switch.off': '队列已停止。任务为空时会自动停止。',
  'settings.title': '调度设置',
  'settings.summary': '空闲 {dispatch} · 提问后 {question}',
  'settings.dispatch': '空闲等待（秒）',
  'settings.question': '提问后等待（秒）',
  'settings.range': '1–86400 秒',
  'settings.invalid': '请输入 1 到 86400 之间的秒数',
  'settings.idle': '以下情况算作忙碌，会占住队列：',
  'settings.idleQuestion': '正在等待提问回答',
  'settings.idlePermission': '正在等待权限确认',
  'settings.idleBackground': '正在运行后台命令',
  'settings.idleOther': '其它会话正在活动',
  'settings.seconds': '{n} 秒',
  'settings.minutes': '{n} 分钟',
  'settings.saved': '调度设置已保存',
  'settings.saveFailed': '调度设置保存失败（{reason}）',
  'composer.label': '新任务（内容即提示词）',
  'composer.enabled': '启用',
  'composer.placeholder': '输入要执行的内容…',
  'composer.runNow': '立即执行',
  'composer.add': '加入队列',
  'composer.append': '追加到会话',
  'composer.image.add': '添加图片',
  'composer.image.uploading': '上传中…',
  'composer.image.remove': '移除图片',
  'composer.image.count': '{n} 张图片',
  'composer.image.untitled': '图片',
  'composer.image.tooMany': '每个任务最多 {n} 张图片',
  'composer.image.tooLarge': '图片过大（上限 {max}）',
  'composer.image.failed': '图片添加失败',
  'composer.image.wait': '请等图片上传完成',
  'list.empty.title': '队列为空',
  'list.empty.body': '在上方添加任务，然后打开开关。',
  'list.empty.bodyCompleted': '已完成 {n} 个任务。添加新任务后需要重新打开开关。',
  'row.clickToEdit': '点击修改',
  'row.top': '置顶',
  'row.run': '执行',
  'row.retry': '重试',
  'row.delete': '删除',
  'row.appendTo': '追加到 {name}',
  'row.enabled': '启用',
  'edit.save': '保存',
  'edit.cancel': '取消',
  'status.pending': '待执行',
  'status.failed': '失败',
  'status.disabled': '已停用',
  'toast.locked': '队列运行中：请先关闭开关再修改任务',
  'toast.enqueued': '已加入队列',
  'toast.ranNow': '已创建新会话并开始执行',
  'toast.noSession': '当前没有打开的会话可追加',
  'toast.noDirectory': '无法确定当前项目目录',
  'toast.noService': '队列服务不可用，请先打开一次队列面板以启动它。',
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
  'mode.unknown': '連線中',
  'count.pending': '待執行 {n}',
  'count.completed': '已完成 {n}',
  'banner.error.title': '正在連線調度服務',
  'banner.error.body': '本機服務正在啟動，連線成功後佇列會自動恢復；若持續如此，請在「設定 → 擴充功能」中核准此擴充功能的本機服務。',
  'empty.noProject.title': '未開啟專案',
  'empty.noProject.body': '在 OpenChamber 中開啟一個專案後即可使用佇列。',
  'switch.label': '啟用佇列',
  'switch.on': '專案連續閒置 {delay} 後，自動建立會話並送出最前面啟用中的任務；若上一個任務停在提問上，改為等待 {question}。',
  'switch.off': '佇列已停止。任務清空時會自動停止。',
  'settings.title': '調度設定',
  'settings.summary': '閒置 {dispatch} · 提問後 {question}',
  'settings.dispatch': '閒置等待（秒）',
  'settings.question': '提問後等待（秒）',
  'settings.range': '1–86400 秒',
  'settings.invalid': '請輸入 1 到 86400 之間的秒數',
  'settings.idle': '以下情況算作忙碌，會佔住佇列：',
  'settings.idleQuestion': '正在等待提問回答',
  'settings.idlePermission': '正在等待權限確認',
  'settings.idleBackground': '正在執行背景命令',
  'settings.idleOther': '其它會話正在活動',
  'settings.seconds': '{n} 秒',
  'settings.minutes': '{n} 分鐘',
  'settings.saved': '調度設定已儲存',
  'settings.saveFailed': '調度設定儲存失敗（{reason}）',
  'composer.label': '新任務（內容即提示詞）',
  'composer.enabled': '啟用',
  'composer.placeholder': '輸入要執行的內容…',
  'composer.runNow': '立即執行',
  'composer.add': '加入佇列',
  'composer.append': '追加到會話',
  'composer.image.add': '新增圖片',
  'composer.image.uploading': '上傳中…',
  'composer.image.remove': '移除圖片',
  'composer.image.count': '{n} 張圖片',
  'composer.image.untitled': '圖片',
  'composer.image.tooMany': '每個任務最多 {n} 張圖片',
  'composer.image.tooLarge': '圖片過大（上限 {max}）',
  'composer.image.failed': '圖片新增失敗',
  'composer.image.wait': '請等圖片上傳完成',
  'list.empty.title': '佇列為空',
  'list.empty.body': '在上方新增任務，然後開啟開關。',
  'list.empty.bodyCompleted': '已完成 {n} 個任務。新增任務後需要重新開啟開關。',
  'row.clickToEdit': '點擊修改',
  'row.top': '置頂',
  'row.run': '執行',
  'row.retry': '重試',
  'row.delete': '刪除',
  'row.appendTo': '追加到 {name}',
  'row.enabled': '啟用',
  'edit.save': '儲存',
  'edit.cancel': '取消',
  'status.pending': '待執行',
  'status.failed': '失敗',
  'status.disabled': '已停用',
  'toast.locked': '佇列執行中：請先關閉開關再修改任務',
  'toast.enqueued': '已加入佇列',
  'toast.ranNow': '已建立新會話並開始執行',
  'toast.noSession': '目前沒有開啟的會話可追加',
  'toast.noDirectory': '無法判斷目前的專案目錄',
  'toast.noService': '佇列服務無法使用，請先開啟一次佇列面板以啟動它。',
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
