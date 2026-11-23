// 探针/校准脚本的打包入口：把真机脚本需要的真实实现集中再导出。
// 只服务于 scripts/ 下的校准工具，不参与 App 打包。
export { liepinAdapter, DEFAULT_LIEPIN } from '../src/main/services/adapters/liepin';
export { HumanOperator } from '../src/main/cdp/human-ops';
export { resolveBehaviorProfile } from '../src/shared/constants';
