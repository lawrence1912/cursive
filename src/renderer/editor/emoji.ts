/**
 * 常用 emoji 短代码 → 字符。
 * 只收录写作里高频的一小批：解析器靠这份表决定 `:name:` 是否成节点，
 * 表里没有的一律保持字面量（`:foo:` 原样显示，不会吞掉时间 `10:30:45` 这类文本）。
 */
export const EMOJI: Record<string, string> = {
  // 表情
  smile: '😄', laugh: '😆', joy: '😂', wink: '😉', blush: '😊', smirk: '😏',
  scream: '😱', cry: '😢', sob: '😭', angry: '😠', rage: '😡', thinking: '🤔',
  sunglasses: '😎', star_struck: '🤩', zzz: '😴', ghost: '👻', skull: '💀',
  robot: '🤖', smiley: '😃', grin: '😁', relieved: '😌', sleepy: '😪',
  // 手势
  '+1': '👍', '-1': '👎', ok_hand: '👌', clap: '👏', wave: '👋', pray: '🙏',
  muscle: '💪', point_right: '👉', point_left: '👈', point_up: '👆',
  point_down: '👇', raised_hands: '🙌', handshake: '🤝', v: '✌️',
  // 常用符号
  heart: '❤️', broken_heart: '💔', sparkles: '✨', fire: '🔥', rocket: '🚀',
  tada: '🎉', check: '✅', white_check_mark: '✅', x: '❌', warning: '⚠️',
  bulb: '💡', question: '❓', exclamation: '❗', zap: '⚡', boom: '💥',
  star: '⭐', rainbow: '🌈', hundred: '💯', eyes: '👀', no_entry: '⛔',
  // 天气自然
  sun: '☀️', moon: '🌙', cloud: '☁️', snowflake: '❄️', umbrella: '☂️',
  // 饮食
  coffee: '☕', beer: '🍺', pizza: '🍕', cake: '🎂', apple: '🍎',
  // 动物
  dog: '🐶', cat: '🐱', bug: '🐛', turtle: '🐢', fish: '🐟',
  // 工作学习
  memo: '📝', pencil: '✏️', pen: '🖊️', book: '📚', notebook: '📓',
  bookmark: '🔖', pushpin: '📌', paperclip: '📎', scissors: '✂️',
  calendar: '📅', clock: '🕐', lock: '🔒', key: '🔑', link: '🔗',
  mag: '🔍', hammer: '🔨', wrench: '🔧', gear: '⚙️', bulb2: '🔦',
  // 设备
  computer: '💻', phone: '📱', camera: '📷', tv: '📺', battery: '🔋',
  // 文件
  folder: '📁', open_file_folder: '📂', page_facing_up: '📄',
  clipboard: '📋', bookmark_tabs: '📑',
  // 生活
  house: '🏠', car: '🚗', airplane: '✈️', ship: '🚢', bike: '🚲',
  gift: '🎁', bell: '🔔', money: '💰', gem: '💎', trophy: '🏆',
  medal: '🏅', chart_with_upwards_trend: '📈', bar_chart: '📊',
  envelope: '✉️', package: '📦', trash: '🗑️', shower: '🚿', bed: '🛏️'
}
