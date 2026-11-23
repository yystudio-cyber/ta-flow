// vue-i18n 配置（阶段8 英语 i18n）
//
// 设计要点：
//   ① 默认中文（zh-CN），与产品主语言一致；英文（en）为第二语言，设置页可切。
//   ② legacy=false（Composition API 模式），用 useI18n() 的 t()。
//   ③ 动态数据不译：候选人姓名/职位/公司、JD 名称与内容、日志 message、探针 verdict
//      这些运行期数据绝不走 t()——只译静态 UI 文案（标题/按钮/表头/说明文）。
//   ④ Element Plus locale 随语言切（main.ts 负责 import + 应用）。
//   ⑤ fallbackLocale='zh-CN'：英文键漏译时回退中文，不暴露 key 给用户。
import { createI18n } from 'vue-i18n';
import { ref } from 'vue';
import zhCnEp from 'element-plus/es/locale/lang/zh-cn';
import enEp from 'element-plus/es/locale/lang/en';
import zhCN from './zh-CN';
import en from './en';

export type AppLocale = 'zh-CN' | 'en';

export const SUPPORTED_LOCALES: { value: AppLocale; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
];

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    en,
  },
  // 缺键不告警刷屏（fallback 已兜底），但开发期可在控制台看 warn
  missingWarn: false,
  fallbackWarn: false,
});

// Element Plus 内置组件文案 locale（ElConfigProvider 的 :locale 绑这个响应式 ref）。
// 与 i18n.global.locale 同步切换——我们的文案走 vue-i18n，ElMessage/ElMessageBox 等内置组件文案走这里。
export const EP_LOCALES: Record<AppLocale, any> = { 'zh-CN': zhCnEp, en: enEp };
export const epLocale = ref<any>(zhCnEp);

/** 切换语言（供设置页 / main.ts 调用）。同步更新 vue-i18n 与 Element Plus locale。返回新 locale。 */
export function setLocale(locale: AppLocale): AppLocale {
  i18n.global.locale.value = locale;
  epLocale.value = EP_LOCALES[locale] || zhCnEp;
  return locale;
}

/** 从 settings 字符串解析出合法 locale，非法回退中文。 */
export function resolveLocale(s: string | undefined | null): AppLocale {
  return s === 'en' ? 'en' : 'zh-CN';
}

export default i18n;
