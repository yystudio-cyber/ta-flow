// Match / scoring handlers
import { BrowserWindow } from 'electron';
import { handle } from './wrap';
import { IPC, JD, CandidateProfile } from '../../shared/types';
import { scoreCandidate } from '../services/scoring';

export function registerMatchHandlers(winGetter: () => BrowserWindow | null) {
  // tier 由调用方显式指定，绝不靠引擎自动判：自动判定把非空 education 当作"深证据"，
  // 而 BOSS/猎聘列表卡恒带 education（卡片上本来就显示学历），导致列表级被误判成 detail，
  // 使卡片层封顶与「卡片不得评 high」两条安全线失效。详情见 scoring.ts 的说明。
  // 若调用方不传（旧调用），统一按 card 兜底——本通道历史上的调用方（匹配评分面板）
  // 输入的是列表卡/手动粘贴的稀疏简历，最安全的口径是卡片档，而不是把它误当成已读详情。
  handle(IPC.MATCH_TEST, (_e, profile: CandidateProfile, jd: JD, tier?: 'card' | 'detail') => {
    return scoreCandidate(profile, jd, tier ?? 'card');
  });
}
