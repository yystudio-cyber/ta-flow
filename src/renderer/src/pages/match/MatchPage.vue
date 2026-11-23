<template>
  <div class="page-wrap">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
      <h1 class="page-h1" style="flex:1">{{ t('match.title') }}</h1>
      <button type="button" class="btn btn-secondary" @click="openImport">{{ t('match.importFromFeishu') }}</button>
      <button type="button" class="btn btn-primary" @click="addJd">{{ t('match.newJd') }}</button>
    </div>

    <!-- 快照收件箱（G2：飞书 JR 快照工具自动推送） -->
    <div v-if="inbox.length" class="card" style="margin-bottom:18px;border-left:4px solid var(--color-accent)">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="card-kicker" style="flex:1">{{ t('match.inboxTitle', { n: inbox.length }) }}</span>
        <button type="button" class="btn btn-ghost" @click="importInbox(inbox.map(i => i.id))">{{ t('match.importAll') }}</button>
        <button type="button" class="btn btn-ghost" style="color:var(--color-neutral-600)" @click="dismissInbox(inbox.map(i => i.id))">{{ t('match.dismissAll') }}</button>
      </div>
      <table class="table" style="margin-top:6px">
        <thead><tr><th>{{ t('match.thPosition') }}</th><th style="width:130px">{{ t('match.thDept') }}</th><th style="width:90px">{{ t('match.thCity') }}</th><th style="width:80px">{{ t('match.thStatus') }}</th><th style="width:130px">{{ t('match.thReceived') }}</th><th style="width:130px">{{ t('match.thAction') }}</th></tr></thead>
        <tbody>
          <tr v-for="it in inbox" :key="it.id">
            <td>{{ it.title }}</td><td>{{ it.dept || '—' }}</td><td>{{ it.city || '—' }}</td>
            <td><span class="tag tag-neutral">{{ it.status || '—' }}</span></td>
            <td style="font-size:12px;color:var(--color-neutral-600)">{{ fmtTime(it.receivedAt) }}</td>
            <td>
              <button type="button" class="btn btn-ghost" @click="importInbox([it.id])">{{ t('match.importOne') }}</button>
              <button type="button" class="btn btn-ghost" style="color:var(--color-neutral-600)" @click="dismissInbox([it.id])">{{ t('match.dismissOne') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 当前激活 JD -->
    <div class="card" style="margin-bottom:18px" :style="{ borderLeft: activeJd ? '4px solid var(--color-accent-2)' : '4px solid var(--color-accent)' }">
      <template v-if="activeJd">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="card-kicker" style="flex:1">{{ t('match.activeJd') }}</span>
          <span class="tag tag-accent-2">{{ t('match.activated') }}</span>
        </div>
        <div style="font-family:var(--font-heading);font-size:20px">{{ activeJd.name }} · {{ activeJd.title }}
          <span class="tag tag-neutral" style="font-size:11px;font-weight:normal;margin-left:6px">{{ weightTemplateLabel((activeJd as any).weightTemplate) }}</span>
        </div>
        <div style="font-size:13px;color:var(--color-neutral-700)">
          {{ activeJd.basic.city }} · {{ activeJd.basic.experienceMin }}-{{ activeJd.basic.experienceMax }}{{ t('match.yearSuffix') }} · {{ activeJd.basic.degree }}
          <span v-if="activeJd.basic.salaryMax"> · {{ activeJd.basic.salaryMin }}-{{ activeJd.basic.salaryMax }}K</span>
        </div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:4px">
          <span class="tag tag-accent-2" v-for="k in activeJd.keywords.required.slice(0,6)" :key="k">✓ {{ k }}</span>
          <span class="tag tag-accent" v-for="k in activeJd.keywords.bonus.slice(0,6)" :key="k">★ {{ k }}</span>
          <span class="tag tag-neutral" v-for="k in activeJd.keywords.negative.slice(0,6)" :key="k">✕ {{ k }}</span>
        </div>
        <!-- 未配 domain/tasks 时如实提示：这两维合计 40% 权重会整维退出加权，
             表现为"分数普遍偏中间、拉不开差距"。不提示的话用户只会觉得"评分不准"。 -->
        <div v-if="activeMissingV4.length" class="v4-hint">
          ⚠ 本岗位未配置<b>{{ activeMissingV4.join(' 与 ') }}</b>（合计 {{ activeMissingWeight }}% 权重整维退出加权）。
          评分仍可用，但区分不出「同样的技术词、不同的应用场景」——例如「金融支付风控」与「电商推荐排序」会被打成同一档。
          <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:12px" @click="editJd(activeJd)">{{ t('match.goFill') }}</button>
        </div>
        <div style="margin-top:6px;display:flex;gap:8px;align-items:center">
          <button type="button" class="btn btn-secondary" @click="editJd(activeJd)">{{ t('match.edit') }}</button>
        </div>
      </template>
      <template v-else>
        <div class="card-kicker">{{ t('match.notActivated') }}</div>
        <div style="font-size:13px;color:var(--color-neutral-700)">{{ t('match.notActivatedDesc') }}</div>
        <div><button type="button" class="btn btn-primary" @click="addJd">{{ t('match.createFirst') }}</button></div>
      </template>
    </div>

    <!-- 岗位列表 -->
    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="card-kicker" style="flex:1">{{ t('match.jdList') }}</span>
        <input class="input" v-model="jdSearch" :placeholder="t('match.searchJdPh')" style="width:240px" />
      </div>
      <table class="table" style="margin-top:8px">
        <thead><tr><th style="width:200px">{{ t('match.thName') }}</th><th>{{ t('match.thPosition') }}</th><th style="width:70px">{{ t('match.thCity') }}</th><th style="width:90px">{{ t('match.thExp') }}</th><th style="width:70px">{{ t('match.thDegree') }}</th><th style="width:90px">{{ t('match.thStatus') }}</th><th style="width:180px">{{ t('match.thAction') }}</th></tr></thead>
        <tbody>
          <tr v-for="row in filteredJds" :key="row.id">
            <td>{{ row.name }}</td><td>{{ row.title }}</td><td>{{ row.basic.city }}</td>
            <td>{{ row.basic.experienceMin }}-{{ row.basic.experienceMax }}{{ t('match.yearSuffix') }}</td><td>{{ row.basic.degree }}</td>
            <td><span class="tag" :class="row.active ? 'tag-accent-2' : 'tag-neutral'">{{ row.active ? t('match.activating') : t('match.inactive') }}</span></td>
            <td>
              <button v-if="!row.active" type="button" class="btn btn-ghost" @click="setActive(row.id)">{{ t('match.activate') }}</button>
              <button type="button" class="btn btn-ghost" @click="editJd(row)">{{ t('match.edit') }}</button>
              <button type="button" class="btn btn-ghost" style="color:var(--color-accent-800)" @click="deleteJd(row.id)">{{ t('common.delete') }}</button>
            </td>
          </tr>
          <tr v-if="!filteredJds.length"><td colspan="7" class="fhint" style="text-align:center;padding:16px">{{ jds.length ? t('match.noJdMatchHint') : t('match.noJdHint') }}</td></tr>
        </tbody>
      </table>
    </div>

    <!-- JD 编辑弹窗 -->
    <div v-if="jdDialogVisible" class="dialog-backdrop" @click.self="jdDialogVisible = false">
      <div class="dialog" style="width:min(720px,100%);max-height:88vh;overflow:auto">
        <div class="dialog-title">{{ editingJd?.id ? t('match.dialogEdit') : t('match.dialogNew') }}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.jdName') }}</label><input class="input" v-model="jdForm.name" placeholder="嵌入式软件工程师-杭州" /></div>
          <div class="field"><label>{{ t('match.jdTitle') }}</label><input class="input" v-model="jdForm.title" placeholder="嵌入式软件工程师" /></div>
        </div>
        <div class="divider">{{ t('match.basicReq') }}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.city') }}</label><select class="input" v-model="jdForm.basic.city"><option v-for="c in cityOptions" :key="c" :value="c">{{ c }}</option></select></div>
          <div class="field"><label>{{ t('match.degreeReq') }}</label><select class="input" v-model="jdForm.basic.degree"><option v-for="d in ['大专','本科','硕士','博士']" :key="d" :value="d">{{ d }}</option></select></div>
          <div class="field"><label>{{ t('match.expRange') }}</label><div style="display:flex;align-items:center;gap:6px"><input class="input" type="number" v-model.number="jdForm.basic.experienceMin" /><span>~</span><input class="input" type="number" v-model.number="jdForm.basic.experienceMax" /></div></div>
          <div class="field"><label>{{ t('match.salaryBudget') }}</label><div style="display:flex;align-items:center;gap:6px"><input class="input" type="number" v-model.number="jdForm.basic.salaryMin" /><span>~</span><input class="input" type="number" v-model.number="jdForm.basic.salaryMax" /></div></div>
        </div>
        <div class="divider">{{ t('match.keywordsSection') }}</div>
        <div class="field"><label>{{ t('match.requiredKw') }}</label><textarea class="input" rows="2" v-model="jdForm.keywords.requiredText" placeholder="嵌入式, C语言, Linux驱动"></textarea></div>
        <div class="field"><label>{{ t('match.bonusKw') }}</label><textarea class="input" rows="2" v-model="jdForm.keywords.bonusText" placeholder="RTOS, CAN总线, 汽车电子"></textarea></div>
        <div class="field"><label>{{ t('match.negativeKw') }}</label><textarea class="input" rows="2" v-model="jdForm.keywords.negativeText" placeholder="纯APP开发, 纯前端"></textarea></div>
        <div class="divider">{{ t('match.industrySection') }}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.preferredIndustry') }}</label><textarea class="input" rows="2" v-model="jdForm.industry.preferredText" placeholder="汽车电子, 芯片, 通信"></textarea></div>
          <div class="field"><label>{{ t('match.excludedIndustry') }}</label><textarea class="input" rows="2" v-model="jdForm.industry.excludedText" placeholder="纯互联网, 金融"></textarea></div>
        </div>
        <div class="divider">{{ t('match.companySection') }}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.preferredCompany') }}</label><textarea class="input" rows="2" v-model="jdForm.companyTier.preferText" placeholder="华为, 字节, 外企, 上市"></textarea></div>
          <div class="field"><label>{{ t('match.excludedCompany') }}</label><textarea class="input" rows="2" v-model="jdForm.companyTier.avoidText" placeholder="外包, 培训"></textarea></div>
        </div>
        <div class="divider">{{ t('match.respSection') }}</div>
        <div class="field"><label>{{ t('match.responsibilities') }}</label><textarea class="input" rows="3" v-model="jdForm.basic.responsibilitiesText" placeholder="负责XX系统后端开发，参与XX项目全生命周期..."></textarea></div>
        <!-- 如实说明这一栏当前的作用范围。原文案是"用于项目经验语义匹配"——语义匹配当前是关的，
             照着填的人会以为它在影响分数，其实（在 JD 配了必选关键词时）不影响。 -->
        <div class="fhint" style="margin-top:-4px;line-height:1.7">
          当前作用：① 下面「任务点」可以按它一键拆草稿（<b>这是它今天最大的价值</b>）；
          ② JD 没填必选关键词时，它让「项目经验」维有据可评，否则该维直接判为无数据。
          语义匹配开启后它才会直接参与算分（当前未开启）。
        </div>

        <!-- ===== v4 应用域（domainFit 维 · 20% 权重）===== -->
        <div class="divider">{{ t('match.domainSection') }}</div>
        <div class="fhint" style="margin:-4px 0 8px;line-height:1.7">
          同一堆技术词，「金融风控引擎」和「电商推荐引擎」是两拨人。填了这里，引擎才能判断候选人的每段经历落在
          <b>同域 / 相邻域 / 远域</b>；不填则本维整维退出加权，退化成只看技术词面。
          <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:12px" @click="fillDomainExample">填个示例看看</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.industryLabel') }}</label><input class="input" v-model="jdForm.domain.industry" placeholder="汽车智能驾驶" /></div>
          <div class="field"><label>{{ t('match.platformLabel') }}</label><input class="input" v-model="jdForm.domain.platform" placeholder="服务端" /></div>
          <div class="field"><label>{{ t('match.viewpointLabel') }}</label><input class="input" v-model="jdForm.domain.viewpoint" placeholder="自车" /></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.scenesLabel') }}</label><input class="input" v-model="jdForm.domain.scenesText" placeholder="在线交易, 核心链路" /></div>
          <div class="field"><label>{{ t('match.sensorsLabel') }}</label><input class="input" v-model="jdForm.domain.sensorsText" placeholder="环鱼眼相机, 超声波雷达" /></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>{{ t('match.adjacentLabel') }}</label><textarea class="input" rows="2" v-model="jdForm.domain.adjacentText" placeholder="支付风控, 交易链路, 实时风控"></textarea></div>
          <div class="field"><label>{{ t('match.distantLabel') }}</label><textarea class="input" rows="2" v-model="jdForm.domain.distantText" placeholder="推荐排序, 广告投放, 安防监控"></textarea></div>
        </div>

        <!-- ===== v4 任务点（taskCoverage 维 · 20% 权重）===== -->
        <div class="divider">{{ t('match.taskSection') }}</div>
        <div class="fhint" style="margin:-4px 0 8px;line-height:1.7">
          把职责拆成能判定的任务点，逐条看候选人有没有真做过。<b>域敏感</b>= 换个应用域就不算数（如「支付风控」）；
          不勾 = 纯工程能力（如「嵌入式部署」），在哪做的都算全额。
          <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:12px" @click="deriveTasksFromResponsibilities">按岗位职责拆一版草稿</button>
        </div>
        <table class="table" v-if="jdForm.tasks.length">
          <thead><tr><th style="min-width:150px">任务点</th><th style="min-width:200px">命中关键词（逗号分隔）</th><th style="width:70px">权重</th><th style="width:76px">域敏感</th><th style="width:56px"></th></tr></thead>
          <tbody>
            <tr v-for="(tk, i) in jdForm.tasks" :key="i">
              <td><input class="input" v-model="tk.label" placeholder="支付风控规则引擎" /></td>
              <td><input class="input" v-model="tk.keywordsText" placeholder="风控, 规则引擎, 反欺诈" /></td>
              <td><input class="input" type="number" min="1" v-model.number="tk.weight" /></td>
              <td style="text-align:center"><input type="checkbox" v-model="tk.domainSensitive" /></td>
              <td><button type="button" class="btn btn-ghost" style="color:var(--color-accent-800)" @click="jdForm.tasks.splice(i, 1)">{{ t('match.removeTask') }}</button></td>
            </tr>
          </tbody>
        </table>
        <div><button type="button" class="btn btn-secondary" @click="addTask">{{ t('match.addTask') }}</button></div>

        <!-- ===== 硬门槛 ===== -->
        <div class="divider">{{ t('match.hardGate') }}</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          <label class="chk"><input type="checkbox" v-model="jdForm.hardFlags.degree" />{{ t('match.degreeReq') }}</label>
          <label class="chk"><input type="checkbox" v-model="jdForm.hardFlags.experience" />{{ t('match.thExp') }}</label>
          <label class="chk"><input type="checkbox" v-model="jdForm.hardFlags.salary" />{{ t('match.salaryBudget') }}</label>
          <label class="chk"><input type="checkbox" v-model="jdForm.hardFlags.city" />{{ t('match.city') }}</label>
          <label class="chk"><input type="checkbox" v-model="jdForm.hardFlags.age" />{{ t('match.ageReq') }}</label>
        </div>
        <div class="field" style="max-width:360px">
          <label>{{ t('match.ageReq') }}</label>
          <div style="display:flex;align-items:center;gap:6px">
            <input class="input" type="number" v-model.number="jdForm.basic.ageMin" :placeholder="t('match.ageNoLimit')" />
            <span>~</span>
            <input class="input" type="number" v-model.number="jdForm.basic.ageMax" :placeholder="t('match.ageNoLimit')" />
          </div>
        </div>
        <div class="fhint" style="margin-top:-4px">
          不填年龄区间 → 年龄维不参与评分（把判据绑定在岗位明示要求上，既可审计也避免无依据地用年龄筛人）。
        </div>

        <div class="divider">{{ t('match.weightSection') }}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
          <span class="fhint" style="margin:0">{{ t('match.quickTemplate') }}</span>
          <button v-for="tpl in weightTemplateOptions" :key="tpl.k" type="button" class="btn" :class="jdForm.weightTemplate === tpl.k ? 'btn-primary' : 'btn-ghost'" @click="applyWeightTemplate(tpl.k)" :title="tpl.desc" style="padding:4px 10px;font-size:12px">{{ tpl.label }}</button>
        </div>
        <div class="fhint" style="margin:0 0 6px">{{ t('match.coreDims') }}</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div class="field" v-for="w in coreWeightFields" :key="w.k"><label :title="w.hint">{{ w.label }}<span v-if="w.hint" class="fhint" style="margin:0"> ⓘ</span></label><input class="input" type="number" v-model.number="jdForm.weights[w.k]" /></div>
        </div>
        <div class="fhint" style="margin:8px 0 6px">{{ t('match.contextDims') }}</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div class="field" v-for="w in contextWeightFields" :key="w.k"><label :title="w.hint">{{ w.label }}<span v-if="w.hint" class="fhint" style="margin:0"> ⓘ</span></label><input class="input" type="number" v-model.number="jdForm.weights[w.k]" /></div>
        </div>
        <div class="fhint" style="margin-top:4px">
          当前合计 {{ totalWeight }}。评分按<b>实际参与加权的维度之和</b>归一化，所以合计多少都行，
          <b>只有维度之间的比例有意义</b>（模板默认合计 107，不是 100）。判不了的维度会整维退出，不占权重。
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" @click="jdDialogVisible = false" :disabled="jdSaving">{{ t('match.cancel') }}</button>
          <button type="button" class="btn btn-primary" @click="saveJd" :disabled="jdSaving">{{ jdSaving ? t('common.saving') : t('match.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 从飞书导入弹窗 -->
    <div v-if="importDialogVisible" class="dialog-backdrop" @click.self="importDialogVisible = false">
      <div class="dialog" style="width:min(960px,100%);max-height:90vh;overflow:auto">
        <div class="dialog-title">{{ t('match.importDialogTitle') }}</div>
        <div class="fhint" style="line-height:1.7">
          支持：①复制飞书表格行（含表头，制表符分隔）粘贴；②粘贴 CSV / JSON；③导入 <code>.csv/.json/.txt</code> 文件。首行为表头，可识别列名：JD名称、岗位名称、城市、经验、学历、薪资、必选/加分/减分关键词、优先/不考虑行业、JD描述。
        </div>
        <div class="seg" style="width:fit-content">
          <label class="seg-opt"><input type="radio" value="auto" v-model="importFormat" />{{ t('match.autoDetect') }}</label>
          <label class="seg-opt"><input type="radio" value="table" v-model="importFormat" />{{ t('match.tableFmt') }}</label>
          <label class="seg-opt"><input type="radio" value="json" v-model="importFormat" />{{ t('match.jsonFmt') }}</label>
        </div>
        <div style="display:flex;gap:8px">
          <input ref="fileInput" type="file" accept=".csv,.json,.txt" style="display:none" @change="onFilePick" />
          <button type="button" class="btn btn-secondary" @click="fileInput?.click()">{{ t('match.selectFile') }}</button>
          <button type="button" class="btn btn-primary" @click="parseImport">{{ t('match.parsePreview') }}</button>
          <button type="button" class="btn btn-ghost" @click="importRawText = ''">{{ t('match.clearInput') }}</button>
        </div>
        <textarea class="input" rows="6" v-model="importRawText" placeholder="从飞书表格整块复制后粘贴到此处（含表头）；或粘贴 CSV / JSON 文本"></textarea>

        <div v-if="parsedDrafts.length">
          <div class="card-kicker" style="margin-bottom:6px">{{ t('match.previewTitle', { n: parsedDrafts.length }) }}</div>
          <div style="max-height:340px;overflow:auto">
            <table class="table">
              <thead><tr><th style="width:36px">#</th><th style="min-width:150px">JD名称</th><th style="min-width:130px">岗位</th><th style="width:90px">城市</th><th style="width:130px">经验</th><th style="width:90px">学历</th><th style="width:130px">薪资K</th><th style="min-width:180px">必选关键词</th><th style="width:60px"></th></tr></thead>
              <tbody>
                <tr v-for="(row, idx) in parsedDrafts" :key="idx">
                  <td>{{ idx + 1 }}</td>
                  <td><input class="input" v-model="row.name" :placeholder="t('match.requiredText')" /></td>
                  <td><input class="input" v-model="row.title" /></td>
                  <td><input class="input" v-model="row.city" /></td>
                  <td><div style="display:flex;align-items:center;gap:3px"><input class="input" type="number" v-model.number="row.experienceMin" style="width:52px;padding:6px 6px" /><span>~</span><input class="input" type="number" v-model.number="row.experienceMax" style="width:52px;padding:6px 6px" /></div></td>
                  <td><select class="input" v-model="row.degree"><option v-for="d in ['大专','本科','硕士','博士']" :key="d" :value="d">{{ d }}</option></select></td>
                  <td><div style="display:flex;align-items:center;gap:3px"><input class="input" type="number" v-model.number="row.salaryMin" style="width:52px;padding:6px 6px" /><span>~</span><input class="input" type="number" v-model.number="row.salaryMax" style="width:52px;padding:6px 6px" /></div></td>
                  <td><input class="input" v-model="row.requiredText" :placeholder="t('match.commaSep')" /></td>
                  <td><button type="button" class="btn btn-ghost" style="color:var(--color-accent-800)" @click="parsedDrafts.splice(idx, 1)">{{ t('match.removeTask') }}</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-secondary" @click="importDialogVisible = false">{{ t('match.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="!parsedDrafts.length" @click="confirmImport">{{ parsedDrafts.length ? t('match.confirmImportN', { n: parsedDrafts.length }) : t('match.confirmImport') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ElMessage, ElMessageBox } from 'element-plus';
const { t } = useI18n();
import type { JD, ScoreWeights, JrInboxItem, JdTask } from '../../../../shared/types';
import { DEFAULT_WEIGHTS, WEIGHT_TEMPLATES, WEIGHT_FIELDS, type WeightTemplateId } from '../../../../shared/constants';

const jds = ref<JD[]>([]);
const activeJd = ref<JD | null>(null);
// 岗位库基础筛选：按名称/岗位/城市/关键词实时过滤，库大了也能快速定位
const jdSearch = ref('');
const filteredJds = computed(() => {
  const kw = jdSearch.value.trim().toLowerCase();
  if (!kw) return jds.value;
  return jds.value.filter((j) =>
    [j.name, j.title, j.basic.city,
     ...j.keywords.required, ...j.keywords.bonus, ...j.keywords.negative]
      .some((v) => (v || '').toLowerCase().includes(kw)),
  );
});
const jdDialogVisible = ref(false);
const editingJd = ref<JD | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
// 设置里配置的"默认权重模板"——新建 JD / 飞书导入时作为初始权重（读不到则回退常量）
const settingsDefaultWeights = ref<ScoreWeights | null>(null);
function defaultWeights(): ScoreWeights { return { ...(settingsDefaultWeights.value || DEFAULT_WEIGHTS) }; }
async function loadDefaultWeights() {
  try {
    const s = await window.api.getSettings();
    if (s?.matchScore?.defaultWeights) settingsDefaultWeights.value = s.matchScore.defaultWeights;
  } catch { /* 读设置失败则用常量默认 */ }
}

const cityOptions = ['北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '武汉', '西安', '苏州', '合肥', '长沙', '重庆', '宁波', '天津', '武汉', '郑州'];
// 权重维度从 shared/constants 的 WEIGHT_FIELDS 渲染（唯一真源）。
// 曾经这里手写 8 维，而引擎是 14 维——用户永远调不到 domainFit/taskCoverage，
// 却在 UI 上被告知"合计 100%"，是假的。
const coreWeightFields = WEIGHT_FIELDS.filter((w) => w.group === 'core');
const contextWeightFields = WEIGHT_FIELDS.filter((w) => w.group === 'context');
const weightTemplateOptions = Object.entries(WEIGHT_TEMPLATES).map(([k, v]) => ({ k: k as WeightTemplateId, label: v.label, desc: v.desc }));

// 激活 JD 缺哪些 v4 关键配置（用于卡片上的如实提示）
const activeMissingV4 = computed(() => {
  const jd: any = activeJd.value;
  if (!jd) return [];
  const miss: string[] = [];
  const d = jd.domain;
  const domainEmpty = !d || !(d.industry || d.platform || d.viewpoint
    || (d.scenes && d.scenes.length) || (d.sensors && d.sensors.length)
    || (d.adjacent && d.adjacent.length) || (d.distant && d.distant.length));
  if (domainEmpty) miss.push('应用域');
  if (!jd.tasks || !jd.tasks.length) miss.push('任务点');
  return miss;
});
const activeMissingWeight = computed(() => {
  const jd: any = activeJd.value;
  const w = (jd && jd.weights) || DEFAULT_WEIGHTS;
  let sum = 0;
  if (activeMissingV4.value.includes('应用域')) sum += Number(w.domainFit ?? DEFAULT_WEIGHTS.domainFit ?? 0);
  if (activeMissingV4.value.includes('任务点')) sum += Number(w.taskCoverage ?? DEFAULT_WEIGHTS.taskCoverage ?? 0);
  return sum;
});

function applyWeightTemplate(id: WeightTemplateId) {
  jdForm.value.weightTemplate = id;
  jdForm.value.weights = { ...WEIGHT_TEMPLATES[id].weights };
}

const jdForm = ref<any>(createEmptyJdForm());
function createEmptyJdForm() {
  return {
    id: '', name: '', title: '', active: false, weightTemplate: 'default' as WeightTemplateId,
    basic: {
      experienceMin: 3, experienceMax: 5, degree: '本科', city: '杭州', salaryMin: 25, salaryMax: 40,
      responsibilitiesText: '', ageMin: undefined as number | undefined, ageMax: undefined as number | undefined,
    },
    keywords: { requiredText: '', bonusText: '', negativeText: '' },
    industry: { preferredText: '', excludedText: '' },
    companyTier: { preferText: '', avoidText: '' },
    domain: { industry: '', platform: '', viewpoint: '', scenesText: '', sensorsText: '', adjacentText: '', distantText: '' },
    tasks: [] as any[],
    hardFlags: { degree: false, experience: false, salary: false, city: false, age: false },
    weights: defaultWeights() as ScoreWeights,
  };
}
const totalWeight = computed(() => Object.values(jdForm.value.weights).reduce((s: number, v: any) => s + (Number(v) || 0), 0));

// ── 应用域 / 任务点的表单辅助 ────────────────────────────────────────────────
function addTask() {
  jdForm.value.tasks.push({ label: '', keywordsText: '', weight: 2, domainSensitive: true });
}
/** 一键给个可改的示例，降低"这一栏到底填什么"的门槛（真机反馈：空栏位没人填） */
function fillDomainExample() {
  jdForm.value.domain = {
    industry: '互联网金融', platform: '服务端', viewpoint: '自车',
    scenesText: '在线交易, 核心链路', sensorsText: '实时数据, 风控',
    adjacentText: '支付风控, 交易链路, 实时风控',
    distantText: '推荐排序, 广告投放, 内容审核, 物流调度',
  };
  ElMessage.info(t('match.msgDomainExample'));
}
/**
 * 按「岗位职责」逐条拆成任务点草稿。
 * 只做机械拆分 + 抽词，不猜语义：拆出来必须由 TA 自己审一遍再保存。
 * 这样做的价值是把"从零写一张表"变成"改一张表"。
 */
function deriveTasksFromResponsibilities() {
  const lines: string[] = String(jdForm.value.basic.responsibilitiesText || '')
    .split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) { ElMessage.warning(t('match.msgFillResponsibilities')); return; }
  const drafted = lines.slice(0, 12).map((line) => {
    const label = line.length > 28 ? line.slice(0, 28) + '…' : line;
    // 抽取候选关键词：英文/数字串 + 顿号逗号分隔的中文短语，去掉太短的
    const en = line.match(/[A-Za-z][A-Za-z0-9+\-_.]{2,}/g) || [];
    const cn = line.split(/[，,、（）()。\s]+/).filter((s) => /[一-龥]/.test(s) && s.length >= 2 && s.length <= 8);
    const kws = Array.from(new Set([...en, ...cn])).slice(0, 8);
    return { label, keywordsText: kws.join(', '), weight: 2, domainSensitive: true };
  });
  jdForm.value.tasks = jdForm.value.tasks.concat(drafted);
  ElMessage.success(t('match.msgDerivedTasks', { n: drafted.length }));
}

async function loadJds() { try { jds.value = await window.api.listJds(); activeJd.value = jds.value.find((j) => j.active) || null; } catch { /* 加载失败由空列表体现 */ } }
function addJd() { editingJd.value = null; jdForm.value = createEmptyJdForm(); jdDialogVisible.value = true; }
function editJd(jd: JD) {
  editingJd.value = jd;
  const d: any = (jd as any).domain || {};
  jdForm.value = {
    id: jd.id, name: jd.name, title: jd.title, active: jd.active,
    weightTemplate: (jd as any).weightTemplate || 'default',
    basic: {
      ...jd.basic,
      responsibilitiesText: (jd.basic.responsibilities || []).join('\n'),
    },
    keywords: { requiredText: jd.keywords.required.join(', '), bonusText: jd.keywords.bonus.join(', '), negativeText: jd.keywords.negative.join(', ') },
    industry: { preferredText: jd.industry.preferred.join(', '), excludedText: jd.industry.excluded.join(', ') },
    companyTier: { preferText: ((jd.companyTier && (jd.companyTier as any).prefer) || []).join(', '), avoidText: ((jd.companyTier && (jd.companyTier as any).avoid) || []).join(', ') },
    domain: {
      industry: d.industry || '', platform: d.platform || '', viewpoint: d.viewpoint || '',
      scenesText: (d.scenes || []).join(', '), sensorsText: (d.sensors || []).join(', '),
      adjacentText: (d.adjacent || []).join(', '), distantText: (d.distant || []).join(', '),
    },
    tasks: ((jd as any).tasks || []).map((t: JdTask) => ({
      key: t.key, label: t.label || '', keywordsText: (t.keywords || []).join(', '),
      weight: t.weight ?? 2, domainSensitive: t.domainSensitive !== false,
    })),
    hardFlags: { degree: false, experience: false, salary: false, city: false, age: false, ...((jd as any).hardFlags || {}) },
    weights: { ...(jd.weights || defaultWeights()) },
  };
  jdDialogVisible.value = true;
}
const jdSaving = ref(false);
async function saveJd() {
  if (jdSaving.value) return;
  if (!jdForm.value.name) { ElMessage.warning(t('match.msgNameRequired')); return; }
  // 省一步：新建的第一个岗位（当前无激活岗位）自动激活，用户不用再点"激活"
  const autoActivate = !editingJd.value && !jds.value.some((j) => j.active);
  const responsibilities = jdForm.value.basic.responsibilitiesText
    ? jdForm.value.basic.responsibilitiesText.split(/[\n;；]+/).map((s: string) => s.trim()).filter(Boolean)
    : [];
  // 表单里的 basic 混了一个只在 UI 用的 responsibilitiesText，别把它写进库
  const { responsibilitiesText: _rt, ...basicRest } = jdForm.value.basic;
  // 域配置：整块为空就存 null，让引擎明确走 notApplicable（而不是存一个全空对象假装配过）
  const df = jdForm.value.domain;
  const domainObj = {
    industry: (df.industry || '').trim() || undefined,
    platform: (df.platform || '').trim() || undefined,
    viewpoint: (df.viewpoint || '').trim() || undefined,
    scenes: splitKeywords(df.scenesText || ''),
    sensors: splitKeywords(df.sensorsText || ''),
    adjacent: splitKeywords(df.adjacentText || ''),
    distant: splitKeywords(df.distantText || ''),
  };
  const domainEmpty = !domainObj.industry && !domainObj.platform && !domainObj.viewpoint
    && !domainObj.scenes.length && !domainObj.sensors.length && !domainObj.adjacent.length && !domainObj.distant.length;
  // 任务点：必须有名字且有关键词才算数（只有名字没关键词的行判不了任何东西，存进去纯噪音）
  const tasks: JdTask[] = jdForm.value.tasks
    .map((t: any) => ({
      key: t.key || undefined,
      label: String(t.label || '').trim(),
      keywords: splitKeywords(t.keywordsText || ''),
      weight: Number(t.weight) > 0 ? Number(t.weight) : 1,
      domainSensitive: !!t.domainSensitive,
    }))
    .filter((t: JdTask) => t.label && t.keywords.length);
  const jd: JD = {
    // ⚠️ 必须以原 JD 打底再覆盖：本函数是从表单【重建】对象的，不 spread 的话
    // 表单没覆盖到的字段（bossJobId、将来新增的任何字段）会在用户每次点"保存"时被静默抹掉。
    ...(editingJd.value || {} as any),
    id: jdForm.value.id, name: jdForm.value.name, title: jdForm.value.title, active: jdForm.value.active || autoActivate,
    basic: {
      ...basicRest,
      responsibilities,
      ageMin: Number.isFinite(jdForm.value.basic.ageMin) ? jdForm.value.basic.ageMin : undefined,
      ageMax: Number.isFinite(jdForm.value.basic.ageMax) ? jdForm.value.basic.ageMax : undefined,
    },
    weightTemplate: jdForm.value.weightTemplate || 'default',
    keywords: { required: splitKeywords(jdForm.value.keywords.requiredText), bonus: splitKeywords(jdForm.value.keywords.bonusText), negative: splitKeywords(jdForm.value.keywords.negativeText) },
    industry: { preferred: splitKeywords(jdForm.value.industry.preferredText), excluded: splitKeywords(jdForm.value.industry.excludedText) },
    companyTier: { prefer: splitKeywords(jdForm.value.companyTier.preferText), avoid: splitKeywords(jdForm.value.companyTier.avoidText) },
    domain: domainEmpty ? null : domainObj,
    tasks,
    hardFlags: { ...jdForm.value.hardFlags },
    weights: { ...jdForm.value.weights },
    createdAt: editingJd.value?.createdAt || Date.now(), updatedAt: Date.now(),
  };
  // D4(2026-08-05)：原实现裸 await 无 try/catch/loading/禁用按钮 —— 保存失败时界面无任何反馈，
  //   用户反复点"保存"会产生重复写、错误的岗位。加 loading/禁用 + 错误提示。
  jdSaving.value = true;
  try {
    await window.api.saveJd(jd);
    ElMessage.success(autoActivate ? t('match.msgSavedActivated') : t('match.msgSaved'));
    jdDialogVisible.value = false;
    await loadJds();
  } catch (e: any) {
    ElMessage.error(t('match.msgSaveFailed', { reason: e?.message || '未知错误' }));
  } finally {
    jdSaving.value = false;
  }
}
async function setActive(id: string) { await window.api.setActiveJd(id); ElMessage.success(t('match.msgActivated')); await loadJds(); }
async function deleteJd(id: string) { try { await ElMessageBox.confirm(t('match.msgConfirmDelete'), t('common.confirm'), { type: 'warning' }); await window.api.deleteJd(id); ElMessage.success(t('match.msgDeleted')); await loadJds(); } catch { /* cancelled */ } }
function splitKeywords(s: string): string[] { return s.split(/[,，、；;\n]/).map((k) => k.trim()).filter(Boolean); }
function weightTemplateLabel(t?: string): string {
  const id = (t || 'default') as WeightTemplateId;
  return WEIGHT_TEMPLATES[id]?.label || '通用';
}

// ==================== 从飞书导入 ====================
interface FeishuJdDraft { name: string; title: string; city: string; experienceMin: number; experienceMax: number; degree: string; salaryMin: number; salaryMax: number; requiredText: string; bonusText: string; negativeText: string; preferredText: string; excludedText: string; description: string; }
const importDialogVisible = ref(false);
const importFormat = ref<'auto' | 'table' | 'json'>('auto');
const importRawText = ref('');
const parsedDrafts = ref<FeishuJdDraft[]>([]);

const HEADER_ALIASES: Record<string, string> = {
  jd名称: 'name', 名称: 'name', jd名: 'name', 岗位标题: 'name', name: 'name',
  岗位名称: 'title', 岗位: 'title', 职位: 'title', 职位名称: 'title', 岗位名: 'title', title: 'title',
  城市: 'city', 工作城市: 'city', 地点: 'city', city: 'city',
  经验: 'experience', 经验要求: 'experience', 工作经验: 'experience', 年限: 'experience', experience: 'experience',
  最低经验: 'experienceMin', 经验下限: 'experienceMin', experiencemin: 'experienceMin',
  最高经验: 'experienceMax', 经验上限: 'experienceMax', experiencemax: 'experienceMax',
  学历: 'degree', 学历要求: 'degree', degree: 'degree',
  薪资: 'salary', 薪资预算: 'salary', 薪资范围: 'salary', 薪资要求: 'salary', salary: 'salary',
  最低薪资: 'salaryMin', 薪资下限: 'salaryMin', salarymin: 'salaryMin',
  最高薪资: 'salaryMax', 薪资上限: 'salaryMax', salarymax: 'salaryMax',
  必选关键词: 'required', 必备关键词: 'required', 必选: 'required', 核心关键词: 'required', 关键词: 'required', required: 'required',
  加分关键词: 'bonus', 加分: 'bonus', 优先关键词: 'bonus', bonus: 'bonus',
  减分关键词: 'negative', 减分: 'negative', 排除关键词: 'negative', negative: 'negative',
  优先行业: 'preferred', 行业偏好: 'preferred', preferred: 'preferred',
  不考虑行业: 'excluded', 排除行业: 'excluded', excluded: 'excluded',
  jd描述: 'description', 职位描述: 'description', 岗位描述: 'description', 描述: 'description', description: 'description',
};
function resolveField(header: string): string | null { const key = header.trim().toLowerCase().replace(/[\s_-]/g, ''); return HEADER_ALIASES[key] || null; }
function toNumber(s: any): number { const m = String(s ?? '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; }
function parseExpRange(s: string): [number, number] { const nums = (s.match(/\d+(\.\d+)?/g) || []).map(Number); if (nums.length >= 2) return [nums[0], nums[1]]; if (nums.length === 1) return [nums[0], nums[0]]; return [0, 0]; }
function parseSalaryRange(s: string): [number, number] { const isWan = /万/.test(s); let nums = (s.match(/\d+(\.\d+)?/g) || []).map(Number); if (isWan) nums = nums.map((n) => n * 10); if (nums.length >= 2) return [Math.round(nums[0]), Math.round(nums[1])]; if (nums.length === 1) return [Math.round(nums[0]), Math.round(nums[0])]; return [0, 0]; }
function normalizeDegree(s: string): string { const t = String(s || ''); if (t.includes('博')) return '博士'; if (t.includes('硕') || /master/i.test(t)) return '硕士'; if (t.includes('专')) return '大专'; if (t.includes('本') || /bachelor/i.test(t)) return '本科'; return '本科'; }
function buildDraft(fields: Record<string, string>): FeishuJdDraft {
  const g = (k: string) => (fields[k] ?? '').trim();
  let expMin = 0, expMax = 0;
  if (g('experience')) [expMin, expMax] = parseExpRange(g('experience'));
  if (g('experienceMin')) expMin = toNumber(g('experienceMin'));
  if (g('experienceMax')) expMax = toNumber(g('experienceMax'));
  if (expMax < expMin) expMax = expMin;
  let salMin = 0, salMax = 0;
  if (g('salary')) [salMin, salMax] = parseSalaryRange(g('salary'));
  if (g('salaryMin')) salMin = toNumber(g('salaryMin'));
  if (g('salaryMax')) salMax = toNumber(g('salaryMax'));
  if (salMax < salMin) salMax = salMin;
  const name = g('name') || g('title');
  return { name, title: g('title') || g('name'), city: g('city') || '杭州', experienceMin: expMin, experienceMax: expMax || expMin, degree: g('degree') ? normalizeDegree(g('degree')) : '本科', salaryMin: salMin, salaryMax: salMax, requiredText: g('required'), bonusText: g('bonus'), negativeText: g('negative'), preferredText: g('preferred'), excludedText: g('excluded'), description: g('description') };
}
function parseJsonDrafts(raw: string): FeishuJdDraft[] {
  const data = JSON.parse(raw); const arr = Array.isArray(data) ? data : [data];
  return arr.filter((o) => o && typeof o === 'object').map((o: Record<string, any>) => { const fields: Record<string, string> = {}; for (const [k, v] of Object.entries(o)) { const f = resolveField(k); if (f) fields[f] = Array.isArray(v) ? v.join(', ') : String(v ?? ''); } return buildDraft(fields); });
}
function parseTabularDrafts(raw: string): FeishuJdDraft[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map((h) => h.trim());
  const fieldKeys = headers.map((h) => resolveField(h));
  if (fieldKeys.filter(Boolean).length === 0) return parseKeyValueDrafts(lines);
  const drafts: FeishuJdDraft[] = [];
  for (let i = 1; i < lines.length; i++) { const cells = lines[i].split(delim); const fields: Record<string, string> = {}; fieldKeys.forEach((fk, idx) => { if (fk) fields[fk] = (cells[idx] ?? '').trim(); }); const d = buildDraft(fields); if (d.name) drafts.push(d); }
  return drafts;
}
function parseKeyValueDrafts(lines: string[]): FeishuJdDraft[] {
  const fields: Record<string, string> = {}; let hit = 0;
  for (const line of lines) { const m = line.split(/[:：]/); if (m.length < 2) continue; const f = resolveField(m[0]); if (f) { fields[f] = m.slice(1).join(':').trim(); hit++; } }
  if (!hit) return []; const d = buildDraft(fields); return d.name ? [d] : [];
}
function openImport() { resetImport(); importDialogVisible.value = true; }
function resetImport() { importFormat.value = 'auto'; importRawText.value = ''; parsedDrafts.value = []; }
async function onFilePick(e: Event) {
  try {
    const input = e.target as HTMLInputElement; const raw = input.files?.[0]; if (!raw) return;
    importRawText.value = await raw.text();
    if (/\.json$/i.test(raw.name)) importFormat.value = 'json'; else if (/\.csv$/i.test(raw.name)) importFormat.value = 'table';
    parseImport(); input.value = '';
  } catch { ElMessage.error(t('match.msgFileReadFailed')); }
}
function parseImport() {
  const raw = importRawText.value.trim();
  if (!raw) { ElMessage.warning(t('match.msgPasteOrFile')); return; }
  let drafts: FeishuJdDraft[] = [];
  try { let fmt = importFormat.value; if (fmt === 'auto') fmt = /^[[{]/.test(raw) ? 'json' : 'table'; drafts = fmt === 'json' ? parseJsonDrafts(raw) : parseTabularDrafts(raw); }
  catch (e: any) { ElMessage.error(t('match.msgParseFailed', { reason: e?.message || '格式无法识别' })); return; }
  if (!drafts.length) { ElMessage.warning(t('match.msgNoValidRow')); return; }
  parsedDrafts.value = drafts; ElMessage.success(t('match.msgParsed', { n: drafts.length }));
}
async function confirmImport() {
  const valid = parsedDrafts.value.filter((d) => (d.name || '').trim());
  if (!valid.length) { ElMessage.warning(t('match.msgNoValidRecord')); return; }
  let ok = 0;
  for (const d of valid) {
    const responsibilities = d.description ? d.description.split(/[\n;；]+/).map((s: string) => s.trim()).filter(Boolean) : [];
    const jd: JD = {
      id: '', name: d.name.trim(), title: (d.title || d.name).trim(), active: false, weightTemplate: 'default',
      basic: { experienceMin: d.experienceMin, experienceMax: d.experienceMax, degree: d.degree, city: d.city, salaryMin: d.salaryMin, salaryMax: d.salaryMax, responsibilities },
      keywords: { required: splitKeywords(d.requiredText), bonus: splitKeywords(d.bonusText), negative: splitKeywords(d.negativeText) },
      industry: { preferred: splitKeywords(d.preferredText), excluded: splitKeywords(d.excludedText) },
      companyTier: { prefer: [], avoid: [] }, weights: defaultWeights(), createdAt: Date.now(), updatedAt: Date.now(),
    } as JD;
    try { await window.api.saveJd(jd); ok++; } catch { /* 单条失败不阻断 */ }
  }
  ElMessage.success(t('match.msgImported', { ok, total: valid.length }));
  importDialogVisible.value = false; await loadJds();
}
// ==================== end ====================

// ==================== G2: 快照收件箱 ====================
const inbox = ref<JrInboxItem[]>([]);
let offJrInbox: (() => void) | null = null;

async function loadInbox() {
  try { inbox.value = await window.api.listJrInbox('new'); } catch { /* ignore */ }
}
function fmtTime(ts: number): string {
  const d = new Date(ts); const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function importInbox(ids: number[]) {
  try {
    const n = await window.api.importJrInbox(ids);
    ElMessage.success(t('match.msgInboxImported', { n }));
    await Promise.all([loadInbox(), loadJds()]);
  } catch (e: any) {
    ElMessage.error(t('match.msgInboxImportFailed', { reason: e?.message || e }));
  }
}
async function dismissInbox(ids: number[]) {
  try {
    await window.api.dismissJrInbox(ids);
    await loadInbox();
  } catch (e: any) {
    ElMessage.error(t('match.msgInboxOpFailed', { reason: e?.message || e }));
  }
}

onMounted(() => {
  loadDefaultWeights();
  loadJds();
  loadInbox();
  offJrInbox = window.api.onJrInbox(({ added }) => {
    loadInbox();
    ElMessage.info(t('match.msgInboxPushed', { n: added }));
  });
});
onBeforeUnmount(() => { offJrInbox?.(); });
</script>

<style scoped>
.dialog-backdrop { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--color-neutral-900) 50%, transparent); z-index: 100; }
.dialog { display: flex; flex-direction: column; gap: 12px; padding: 20px 22px; border-radius: var(--radius-lg); background: var(--color-surface); box-shadow: var(--shadow-lg); }
.dialog-title { font-family: var(--font-heading); font-size: 20px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.table td { vertical-align: middle; }
.table .input { min-height: 32px; padding: 4px 10px; font-size: 13px; }
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; cursor: pointer; }
.v4-hint {
  margin-top: 8px; padding: 8px 10px; border-radius: var(--radius-sm, 6px);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  font-size: 12.5px; line-height: 1.7; color: var(--color-neutral-800);
}
</style>
