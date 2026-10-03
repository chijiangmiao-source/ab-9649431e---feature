// 航电密钥轮换复核 —— 核心状态模型与穷尽交织搜索
//
// 两枚独立安全模块（控制端到模块为按发起顺序的 FIFO 通道）处理四类指令：
//   prepare <模块> <密钥指纹>  准备（持久暂存）一枚纪元密钥
//   activate <模块>           将已暂存密钥提交为持久纪元
//   issue   <模块> <发布标识> 以当前持久纪元密钥确认一份发布令
//   recover <模块>            断电恢复：仅重放已落盘记录
//
// 每条指令的生命周期：投递 -> 持久写入 -> 确认；三个边界都可能断电：
//   写入前断电：未落盘，指令丢失；写入后确认前断电：已落盘未确认，恢复后重放，
//   重传/迟到确认不得改变记录；确认后断电：记录已生效，等待恢复后续做。
//
// 模块规范状态（canonical state）仅由三部分构成：
//   持久纪元 ep(-1 未激活 / 0 旧 / 1 新)、准备密钥 prep、已确认发布集合 bits[id]
// 等价前缀（同调度位置、同规范状态）在穷举中合并。

export const NONE = -1;

// 事件类型（序号即生命周期顺序，也用于同长度见证的稳定排序）
export const EVT = Object.freeze({
  DELIVER: 0, // 投递
  WRITE: 1, // 持久写入
  FAULT_PRE: 2, // 断电：持久写入前
  FAULT_POST: 3, // 断电：持久写入后、确认前
  ACK: 4, // 确认
  FAULT_ACK: 5, // 断电：确认后
  DUP_ACK: 6, // 恢复后到达的迟到/重复确认（必须幂等）
});

export const EVT_LABEL = Object.freeze({
  [EVT.DELIVER]: '投递',
  [EVT.WRITE]: '持久写入',
  [EVT.FAULT_PRE]: '断电（写入前）',
  [EVT.FAULT_POST]: '断电（写入后确认前）',
  [EVT.ACK]: '确认',
  [EVT.FAULT_ACK]: '断电（确认后）',
  [EVT.DUP_ACK]: '迟到/重复确认',
});

export const EVT_VERB = Object.freeze({
  prepare: '准备',
  activate: '激活',
  issue: '签发',
  recover: '恢复',
});

const OP_ALIASES = Object.freeze({
  prepare: 'prepare',
  activate: 'activate',
  issue: 'issue',
  recover: 'recover',
  准备: 'prepare',
  激活: 'activate',
  签发: 'issue',
  恢复: 'recover',
});

// ---------- 输入解析与一次性校验（全部错误一次指出） ----------

// raw: {oldFp, newFp, modules:[{id, epoch:'-1'|'0'|'1', prep:'-1'|'0'|'1', confirmed}],
//        instructionsText}
export function parseModel(raw) {
  const errors = [];
  const oldFp = (raw.oldFp ?? '').trim();
  const newFp = (raw.newFp ?? '').trim();
  if (!oldFp) errors.push('未填写旧密钥指纹。');
  if (!newFp) errors.push('未填写新密钥指纹。');
  if (oldFp && newFp && oldFp === newFp)
    errors.push('旧、新密钥指纹不得相同（轮换必须指向不同纪元密钥）。');
  const fpRe = /^[A-Za-z0-9:_-]+$/;
  for (const [label, fp] of [['旧', oldFp], ['新', newFp]]) {
    if (fp && !fpRe.test(fp))
      errors.push(`${label}密钥指纹包含非法字符（仅允许字母、数字、: _ -）。`);
  }
  const keyOf = (fp) => (fp === oldFp ? 0 : fp === newFp ? 1 : NONE);
  const resolveFp = (token) => (token === '旧' ? oldFp : token === '新' ? newFp : token);

  // 模块标识
  const mods = raw.modules ?? [];
  const ids = [0, 1].map((n) => ((mods[n]?.id ?? '').trim()));
  if (!ids[0]) errors.push('未填写模块 1 的标识。');
  if (!ids[1]) errors.push('未填写模块 2 的标识。');
  if (ids[0] && ids[1] && ids[0] === ids[1])
    errors.push(`两枚模块标识重复：“${ids[0]}”，模块标识必须互不相同。`);
  const targetIndex = (token) => ids.findIndex((id) => id && id === token);

  // 发布标识 intern 表（初态与签发指令统一编号）
  const idTable = [];
  const internId = (id) => {
    let n = idTable.indexOf(id);
    if (n < 0) {
      n = idTable.length;
      idTable.push(id);
    }
    return n;
  };
  const idRe = /^[\w.\-]+$/;

  function parseInitial(m, label) {
    const init = { ep: NONE, prep: NONE, bits: new Map() };
    if (!ids[label]) return init;
    const ep = (m.epoch ?? '-1').toString();
    if (ep === '0' || ep === '1') init.ep = Number(ep);
    else if (ep !== '' && ep !== '-1')
      errors.push(`模块“${ids[label]}”的持久纪元初态非法（应为 旧/新/未激活）。`);

    const prep = (m.prep ?? '-1').toString();
    if (prep === '0' || prep === '1') init.prep = Number(prep);
    else if (prep !== '' && prep !== '-1')
      errors.push(`模块“${ids[label]}”的准备密钥初态非法（应为 旧/新/未激活）。`);

    const text = (m.confirmed ?? '').trim();
    for (let part of text ? text.split(',') : []) {
      part = part.trim();
      if (!part) continue;
      const seg = part.split(':');
      if (seg.length !== 2 || !seg[0].trim() || !seg[1].trim()) {
        errors.push(
          `模块“${ids[label]}”的已确认初态条目“${part}”格式非法，应为 发布标识:密钥指纹。`,
        );
        continue;
      }
      const pid = seg[0].trim();
      const fp = resolveFp(seg[1].trim());
      if (!idRe.test(pid)) {
        errors.push(
          `模块“${ids[label]}”初态发布标识“${pid}”含非法字符（允许字母数字 _ . -）。`,
        );
        continue;
      }
      const k = keyOf(fp);
      if (k === NONE) {
        errors.push(
          `模块“${ids[label]}”初态中的密钥指纹“${fp}”不是已声明的旧或新密钥。`,
        );
        continue;
      }
      const n = internId(pid);
      init.bits.set(n, (init.bits.get(n) ?? 0) | (1 << k));
    }
    return init;
  }

  const inits = [0, 1].map((n) => parseInitial(mods[n] ?? {}, n));

  // 指令解析（控制端发起顺序即行序，至多 16 条）
  const instructions = [];
  let lineNo = 0;
  for (const rawLine of (raw.instructionsText ?? '').split(/\r?\n/)) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue; // 空行与 # 注释行不计入指令
    if (instructions.length >= 16) {
      errors.push(`第 ${lineNo} 行：指令数量超过上限 16 条，超出部分不予受理。`);
      break;
    }
    const tokens = line.split(/\s+/);
    const opToken = tokens[0];
    const op = OP_ALIASES[opToken.toLowerCase?.() ?? opToken] ?? OP_ALIASES[opToken];
    const where = `第 ${lineNo} 行指令“${line}”`;
    if (!op) {
      errors.push(
        `${where}：未知指令类型“${opToken}”，应为 prepare/activate/issue/recover（准备/激活/签发/恢复）。`,
      );
      continue;
    }
    const targetTok = tokens[1] ?? '';
    if (!targetTok) {
      errors.push(`${where}：缺少指令目标模块标识。`);
      continue;
    }
    const mi = targetIndex(targetTok);
    if (mi < 0) {
      errors.push(`${where}：目标模块“${targetTok}”不是已声明的两枚模块之一。`);
      continue;
    }
    const arg = tokens[2] ?? '';
    const extra = tokens[3];
    const rec = { idx: instructions.length, lineNo, op, target: mi, arg: null, text: line };
    if (op === 'prepare') {
      if (!arg || extra) {
        errors.push(`${where}：准备指令格式应为 prepare <模块> <密钥指纹>。`);
      } else {
        const k = keyOf(resolveFp(arg));
        if (k === NONE)
          errors.push(`${where}：密钥指纹“${arg}”不是已声明的旧或新密钥。`);
        rec.arg = k;
      }
    } else if (op === 'issue') {
      if (!arg || extra) {
        errors.push(`${where}：签发指令格式应为 issue <模块> <发布标识>。`);
      } else if (!idRe.test(arg)) {
        errors.push(`${where}：发布标识“${arg}”含非法字符（允许字母数字 _ . -）。`);
      } else {
        rec.arg = internId(arg);
      }
    } else if (arg) {
      errors.push(`${where}：${op === 'activate' ? '激活' : '恢复'}指令不接受额外参数。`);
    }
    instructions.push(rec);
  }

  // 恢复前无故障：恢复指令之前，同模块必须存在可断电的在先指令。
  const seenTarget = [false, false];
  for (const ins of instructions) {
    if (ins.op === 'recover' && !seenTarget[ins.target]) {
      errors.push(
        `第 ${ins.lineNo} 行：模块“${ids[ins.target]}”在此恢复指令之前没有任何在先指令可能断电（恢复前无故障）。`,
      );
    }
    seenTarget[ins.target] = true;
  }

  if (errors.length) return { errors };

  // 统一补齐每个模块的已确认位向量
  for (const init of inits) {
    const arr = new Array(idTable.length).fill(0);
    for (const [n, b] of init.bits) arr[n] = b;
    init.bits = arr;
  }

  return {
    model: {
      keys: [oldFp, newFp],
      moduleIds: [ids[0], ids[1]],
      inits,
      instructions,
      idTable,
      queues: [
        instructions.filter((x) => x.target === 0).map((x) => x.idx),
        instructions.filter((x) => x.target === 1).map((x) => x.idx),
      ],
    },
  };
}

// ---------- 现场事件前缀（至多 8 步的已观察事件，不是新的控制端指令） ----------
//
// 每行一步：<模块标识> #<指令序号> <事件>
// 指令序号即控制端发起顺序（从 1 起）；事件仅限当前状态下确实可发生的迁移。
// 归约严格复用既有持久化语义（transitions）：从持久初态逐步重放，首个不合法步
// 即唯一定位；若前缀自身已形成违约，则完整见证从该前缀开始展示。

const PREFIX_EVT_ALIASES = Object.freeze({
  投递: EVT.DELIVER,
  落盘: EVT.WRITE,
  持久写入: EVT.WRITE,
  确认: EVT.ACK,
  断电前: EVT.FAULT_PRE,
  写入前断电: EVT.FAULT_PRE,
  断电后: EVT.FAULT_POST,
  写入后断电: EVT.FAULT_POST,
  断电确认: EVT.FAULT_ACK,
  确认后断电: EVT.FAULT_ACK,
  迟到确认: EVT.DUP_ACK,
  重复确认: EVT.DUP_ACK,
});

export const PREFIX_MAX_STEPS = 8;

// 返回 {blank:true}（无有效行）、{error:{step,lineNo,message}} 或
// {actions,steps,state,violationIndex,remaining}
function reducePrefix(model, text) {
  const src = String(text ?? '').split(/\r?\n/);
  const lines = [];
  src.forEach((raw, k) => {
    const line = raw.trim();
    if (line && !line.startsWith('#')) lines.push({ lineNo: k + 1, line });
  });
  if (!lines.length) return { blank: true };
  if (lines.length > PREFIX_MAX_STEPS) {
    const x = lines[PREFIX_MAX_STEPS];
    return {
      error: {
        step: PREFIX_MAX_STEPS + 1,
        lineNo: x.lineNo,
        message:
          `现场前缀第 ${PREFIX_MAX_STEPS + 1} 步（第 ${x.lineNo} 行“${x.line}”）：` +
          `现场前缀至多 ${PREFIX_MAX_STEPS} 步，超出部分不予归约（现场记录不能追加为新指令）。`,
      },
    };
  }

  let s = initialState(model);
  if (isViolation(model, s) !== null) {
    const x = lines[0];
    return {
      error: {
        step: 1,
        lineNo: x.lineNo,
        message:
          `现场前缀第 1 步（第 ${x.lineNo} 行“${x.line}”）：持久初态已构成零动作违约，` +
          '不存在可继续归约的现场前缀。',
      },
    };
  }

  const actions = [];
  const steps = [snapshot(model, s, null)];
  for (let k = 0; k < lines.length; k++) {
    const { lineNo, line } = lines[k];
    const step = k + 1;
    const at = `现场前缀第 ${step} 步（第 ${lineNo} 行“${line}”）`;
    const fail = (msg) => ({ error: { step, lineNo, message: `${at}：${msg}` } });

    const tokens = line.split(/\s+/);
    const [tokM, tokI, tokE, ...rest] = tokens;
    const m = model.moduleIds.indexOf(tokM);
    if (m < 0) return fail(`模块“${tokM ?? ''}”不是已声明的两枚模块之一。`);

    const im = (tokI ?? '').match(/^#(\d+)$/);
    if (!im) return fail('第二步必须为“#指令序号”（序号即控制端发起顺序，从 1 起）。');
    const n = Number(im[1]);
    if (n < 1 || n > model.instructions.length)
      return fail(`指令序号 #${n} 超出已录入指令范围（1…${model.instructions.length}）。`);
    const i = n - 1;

    let kind = PREFIX_EVT_ALIASES[tokE];
    if (kind === undefined && tokE === '恢复' && model.instructions[i].op !== 'recover')
      return fail(`“恢复”只能引用 recover 指令；#${n} 是${EVT_VERB[model.instructions[i].op]}指令。`);
    if (tokE === '恢复' && model.instructions[i].op === 'recover') kind = EVT.WRITE;
    if (kind === undefined)
      return fail(
        `未知事件“${tokE ?? ''}”，应为 投递/落盘/确认/断电前/断电后/断电确认/迟到确认 之一。`,
      );
    if (rest.length)
      return fail(`多余内容“${rest.join(' ')}”，每步格式必须为：模块 #指令序号 事件。`);

    const ins = model.instructions[i];
    if (ins.target !== m)
      return fail(
        `指令 #${n} 的目标模块是“${model.moduleIds[ins.target]}”，不属于“${model.moduleIds[m]}”；` +
        '现场记录必须精确引用当前模块在途的指令。',
      );

    const ts = transitions(s, model);
    const t = ts.find((x) => x.m === m && x.i === i && x.kind === kind);
    if (!t) return fail(illegalReason(model, s, m, i, kind));

    actions.push({ m, i, kind, lineNo });
    s = t.ns;
    steps.push(snapshot(model, s, { m, i, kind }));
    const v = isViolation(model, s);
    if (v !== null) {
      return { actions, steps, state: s, violationIndex: step, idIdx: v, remaining: lines.length - step };
    }
  }
  return { blank: false, actions, steps, state: s, violationIndex: null, remaining: 0 };
}

function illegalReason(model, s, m, i, kind) {
  const here = transitions(s, model).filter((t) => t.m === m && t.i === i);
  const pos = model.queues[m].indexOf(i);
  if (!here.length) {
    if (pos < s.h[m])
      return `指令 #${i + 1} 在该模块上已处理完毕，不能重复其生命周期事件；` +
        '恢复后才观察到的确认须记为“迟到确认”。';
    if (s.infl[m])
      return `该模块在途槽位正被指令 #${s.infl[m].i + 1} 占用，FIFO 顺序下 #${i + 1} 此刻不能投递。`;
    return `指令 #${i + 1} 此刻不在该模块 FIFO 队首（前序指令尚未走完），不能跳过发起顺序。`;
  }
  if (kind === EVT.DUP_ACK)
    return '该指令此刻没有可观察的迟到/重复确认：仅当其确认在断电后滞留、且模块已恢复在线时才可记录“迟到确认”。';
  const allow = here.map((t) => EVT_LABEL[t.kind]).join('、');
  return `事件“${EVT_LABEL[kind]}”在当前双模块状态下不可能发生；` +
    `#${i + 1}（${model.instructions[i].text}）此刻仅可记录：${allow}。`;
}

function prefixBreachReport(model, pf) {
  const last = pf.steps[pf.steps.length - 1];
  const conflictKeys = [0, 1].map((m) => ({
    module: m,
    bits: last.modules[m].confirmed.find((x) => x.idIdx === pf.idIdx)?.bits ?? 0,
  }));
  return {
    violation: true,
    conflictId: model.idTable[pf.idIdx],
    conflictKeys,
    witnessActions: pf.actions.map((a) => ({ m: a.m, kind: a.kind, i: a.i })),
    steps: pf.steps,
    summary: {
      visited: 1,
      depth: 0,
      merges: 0,
      terminals: 0,
      distinctCanon: 1,
      eventCounts: new Array(7).fill(0),
    },
    prefixLength: pf.actions.length,
    prefixSteps: pf.steps,
    withinPrefix: true,
    prefixIgnored: pf.remaining,
  };
}

// ---------- 规范状态与穷举搜索 ----------

function canonKey(c) {
  const parts = [];
  for (let i = 0; i < c.bits.length; i++) if (c.bits[i]) parts.push(`${i}:${c.bits[i]}`);
  return `${c.ep === NONE ? 2 : c.ep}/${c.prep === NONE ? 2 : c.prep}/${parts.join(',')}`;
}

function stateKey(s) {
  // 注意：late（可能到达的迟到确认集合）不进入状态键。
  // 迟到/重复确认纯无效果且不阻塞任何其他事件，其“何时消化”不影响规范状态与
  // 安全性（幂等不变量），故 DUP_ACK 在 BFS 中按自环吸收，避免消化时机组合爆炸。
  return [
    `${s.h[0]}.${s.h[1]}`,
    `${s.mode[0]}${s.mode[1]}`,
    s.infl[0] ? `${s.infl[0].i}.${s.infl[0].ph}` : '-',
    s.infl[1] ? `${s.infl[1].i}.${s.infl[1].ph}` : '-',
    canonKey(s.canon[0]),
    canonKey(s.canon[1]),
  ].join('|');
}

function initialState(model) {
  return {
    h: [0, 0],
    mode: [0, 0], // 0 在线  1 断电
    infl: [null, null], // 在途指令 {i, ph: 0已投递/1已落盘}
    // 各指令断电后可能晚到的确认（不论其写入是否落盘）；恢复后消化，必须全部幂等
    late: [[], []],
    canon: [
      { ep: model.inits[0].ep, prep: model.inits[0].prep, bits: model.inits[0].bits.slice() },
      { ep: model.inits[1].ep, prep: model.inits[1].prep, bits: model.inits[1].bits.slice() },
    ],
  };
}

function cloneState(s) {
  return {
    h: [s.h[0], s.h[1]],
    mode: [s.mode[0], s.mode[1]],
    infl: [s.infl[0] ? { ...s.infl[0] } : null, s.infl[1] ? { ...s.infl[1] } : null],
    late: [s.late[0].slice(), s.late[1].slice()],
    canon: [
      { ep: s.canon[0].ep, prep: s.canon[0].prep, bits: s.canon[0].bits },
      { ep: s.canon[1].ep, prep: s.canon[1].prep, bits: s.canon[1].bits },
    ],
  };
}

function writeEffect(ins, canon) {
  // 落盘对规范状态的效果；无效应写入（重复暂存/激活、无密钥激活、未激活签发、恢复）返回 false。
  switch (ins.op) {
    case 'prepare':
      if (canon.prep === ins.arg) return false;
      canon.prep = ins.arg;
      return true;
    case 'activate':
      if (canon.prep === NONE || canon.ep === canon.prep) return false;
      canon.ep = canon.prep;
      return true;
    case 'issue':
      if (canon.ep === NONE) return false; // 未持久激活：签发不成立
      canon.bits = canon.bits.slice();
      canon.bits[ins.arg] |= 1 << canon.ep;
      return true;
    case 'recover':
      return false; // 规范状态本就等于落盘记录的重放结果
  }
  return false;
}

// 从状态 s 出发的全部一步迁移，已按 (模块, 指令序号, 事件类型) 稳定排序。
function addLate(late, m, i) {
  // FIFO 保证插入序号单调递增；保持集合有序便于规范键稳定
  if (!late[m].includes(i)) late[m].push(i);
}

function transitions(s, model) {
  const out = [];
  for (let m = 0; m < 2; m++) {
    const head = s.h[m] < model.queues[m].length ? model.queues[m][s.h[m]] : null;

    // 恢复在线后，各断电指令的迟到/重复确认可任意顺序到达；不改变规范状态，也不阻塞投递
    if (s.mode[m] === 0) {
      for (const i of s.late[m]) {
        out.push({
          m,
          i,
          kind: EVT.DUP_ACK,
          build: (ns) => {
            ns.late[m] = ns.late[m].filter((x) => x !== i);
          },
        });
      }
    }

    // 投递队首：FIFO 保证该模块的控制端发起顺序。
    // 断电中正常指令也可到达模块，但尚未持久化即丢失（等价于写入前断电）；
    // 不落盘的内容恢复时不会重放。恢复指令在断电中同样可投递。
    if (s.infl[m] === null && head !== null) {
      out.push({
        m,
        i: head,
        kind: EVT.DELIVER,
        build: (ns) => {
          ns.h[m] += 1;
          ns.infl[m] = { i: head, ph: 0 };
        },
      });
    }

    const inf = s.infl[m];
    if (inf && inf.ph === 0) {
      const ins = model.instructions[inf.i];
      out.push({
        // 写入前断电：未落盘，指令丢失（断电期间到达同样落此结果），其确认标记为迟到
        m,
        i: inf.i,
        kind: EVT.FAULT_PRE,
        build: (ns) => {
          ns.infl[m] = null;
          ns.mode[m] = 1;
          addLate(ns.late, m, inf.i);
        },
      });
      if (s.mode[m] === 0 || ins.op === 'recover') {
        out.push({
          // 持久写入（在线写入；断电中仅恢复指令执行落盘重放并使模块恢复在线）
          m,
          i: inf.i,
          kind: EVT.WRITE,
          build: (ns) => {
            writeEffect(ins, ns.canon[m]);
            if (ins.op === 'recover') ns.mode[m] = 0;
            ns.infl[m] = { i: inf.i, ph: 1 };
          },
        });
      }
    } else if (inf && inf.ph === 1) {
      const ins = model.instructions[inf.i];
      out.push({
        // 写入后确认前断电：效果已落盘，确认丢失，恢复后该确认作为迟到确认重放
        m,
        i: inf.i,
        kind: EVT.FAULT_POST,
        build: (ns) => {
          ns.infl[m] = null;
          ns.mode[m] = 1;
          addLate(ns.late, m, inf.i);
        },
      });
      out.push({
        // 确认完成
        m,
        i: inf.i,
        kind: EVT.ACK,
        build: (ns) => {
          ns.infl[m] = null;
        },
      });
      out.push({
        // 确认后断电：记录已生效，对端/重传的确认在恢复后仍可能到达
        m,
        i: inf.i,
        kind: EVT.FAULT_ACK,
        build: (ns) => {
          ns.infl[m] = null;
          ns.mode[m] = 1;
          addLate(ns.late, m, inf.i);
        },
      });
    }
  }
  out.sort((a, b) => a.m - b.m || a.i - b.i || a.kind - b.kind);
  return out.map((t) => {
    const ns = cloneState(s);
    t.build(ns);
    return { m: t.m, i: t.i, kind: t.kind, ns };
  });
}

function isViolation(model, s) {
  // 同标识发布被两模块以不同纪元密钥确认（各自确认位掩码非空且不一致）
  const a = s.canon[0].bits;
  const b = s.canon[1].bits;
  for (let i = 0; i < model.idTable.length; i++) {
    if (a[i] && b[i] && a[i] !== b[i]) return i;
  }
  return null;
}

// 父边：{p: 父状态键, m, kind, i}；违约候选各自挂独立节点，避免覆盖。
function chainLess(parent, getParent, k1, k2) {
  const pull = (get, k) => {
    const seq = [];
    while (k !== null) {
      const e = get(k);
      if (!e || e.p === null) break;
      seq.push([e.m, e.i ?? -1, e.kind]);
      k = e.p;
    }
    return seq.reverse();
  };
  const a = pull(getParent, k1);
  const b = pull(getParent, k2);
  const n = Math.min(a.length, b.length);
  for (let d = 0; d < n; d++) {
    for (let c = 0; c < 3; c++) {
      if (a[d][c] !== b[d][c]) return a[d][c] < b[d][c];
    }
  }
  return a.length < b.length;
}

// onProgress({visited, depth, merges}) 可周期性返回 true 请求停止（UI 取消）。
// startOverride：合法现场前缀归约所得双模块状态，从此状态继续穷尽尚未发生的交织。
export function explore(model, onProgress, startOverride = null) {
  const start = startOverride ?? initialState(model);
  const k0 = stateKey(start);
  const states = new Map([[k0, start]]);
  const parent = new Map([[k0, { p: null }]]);
  const visited = new Set([k0]);
  const canonJoint = new Set([`${canonKey(start.canon[0])}||${canonKey(start.canon[1])}`]);

  let merges = 0;
  let terminals = 0;
  let depth = 0;
  let cancelled = false;
  const eventCounts = new Array(7).fill(0); // 各事件类型在穷举中出现的迁移数

  const startBad = isViolation(model, start);
  let bestNode = startBad === null ? null : { key: k0, badParent: null, idIdx: startBad };

  let frontier = [k0];
  let representativeTerminal = null; // 任一耗尽全部队列的终态键（供安全摘要展示）
  let terminalBothOnline = false;
  while (!bestNode && frontier.length && !cancelled) {
    const nextLayer = new Map();
    const badNodes = []; // {key, edge:{p,m,kind,i}, idIdx}
    let badSeq = 0;
    for (const key of frontier) {
      const s = states.get(key);
      const ts = transitions(s, model);
      if (ts.length === 0) {
        terminals += 1;
        // 优先记录双模块均在线恢复的平静终态
        if (
          representativeTerminal === null ||
          (s.mode[0] === 0 && s.mode[1] === 0 && !terminalBothOnline)
        ) {
          representativeTerminal = key;
          terminalBothOnline = s.mode[0] === 0 && s.mode[1] === 0;
        }
      }
      for (const t of ts) {
        eventCounts[t.kind] += 1;
        const nk = stateKey(t.ns);
        const bad = isViolation(model, t.ns);
        if (bad !== null) {
          // 违约状态不再展开；每个候选独立挂节点，保留完整父链信息
          const bk = `bad#${badSeq++}`;
          badNodes.push({ key: bk, edge: { p: key, m: t.m, kind: t.kind, i: t.i }, idIdx: bad });
          continue;
        }
        if (visited.has(nk) || nextLayer.has(nk)) {
          merges += 1;
          continue;
        }
        nextLayer.set(nk, { from: key, m: t.m, kind: t.kind, i: t.i });
        states.set(nk, t.ns);
        canonJoint.add(`${canonKey(t.ns.canon[0])}||${canonKey(t.ns.canon[1])}`);
      }
    }
    if (badNodes.length) {
      // 首次出现违约的层即最短动作数；候选间按 (模块, 指令标识, 事件) 稳定序取最小
      const badParent = new Map();
      for (const b of badNodes) badParent.set(b.key, b.edge);
      const getEdge = (k) => badParent.get(k) ?? parent.get(k);
      let best = badNodes[0];
      for (const b of badNodes.slice(1)) {
        if (chainLess(null, getEdge, b.key, best.key)) best = b;
      }
      bestNode = { key: best.key, badParent, idIdx: best.idIdx };
      break;
    }
    for (const [nk, e] of nextLayer) {
      visited.add(nk);
      parent.set(nk, { p: e.from, m: e.m, kind: e.kind, i: e.i });
    }
    frontier = [...nextLayer.keys()];
    depth += 1;
    if (onProgress && depth % 2 === 0) {
      cancelled = !!onProgress({ visited: visited.size, depth, merges });
    }
  }

  if (cancelled) return { cancelled: true };

  const summary = {
    visited: visited.size,
    depth,
    merges,
    terminals,
    distinctCanon: canonJoint.size,
    eventCounts: eventCounts.slice(),
  };

  if (!bestNode) {
    const terminalState = representativeTerminal ? states.get(representativeTerminal) : start;
    return {
      violation: false,
      summary,
      terminalSnapshot: snapshot(model, terminalState, null),
    };
  }

  // 重建最短见证动作序列，并从初态逐步重放取得每步双模块快照
  const getEdge = (k) => (bestNode.badParent?.get(k) ?? parent.get(k));
  const actions = [];
  for (let k = bestNode.key; ; ) {
    const e = getEdge(k);
    if (!e || e.p === null) break;
    actions.push({ m: e.m, kind: e.kind, i: e.i });
    k = e.p;
  }
  actions.reverse();

  const steps = [snapshot(model, start, null)];
  let s = start;
  for (const a of actions) {
    const ts = transitions(s, model);
    const t = ts.find((x) => x.m === a.m && x.kind === a.kind && x.i === a.i);
    if (!t) throw new Error(`内部错误：见证重放失败 m=${a.m} i=${a.i} kind=${a.kind}`);
    s = t.ns;
    steps.push(snapshot(model, s, a));
  }

  const idIdx = bestNode.idIdx;
  const last = steps[steps.length - 1];
  const conflictKeys = [0, 1].map((m) => {
    const entry = last.modules[m].confirmed.find((x) => x.idIdx === idIdx);
    return { module: m, bits: entry.bits };
  });

  return {
    violation: true,
    conflictId: model.idTable[idIdx],
    conflictKeys,
    witnessActions: actions,
    steps,
    summary,
  };
}

function snapshot(model, s, action) {
  const fmt = (m) => ({
    mode: s.mode[m] === 0 ? 'online' : 'down',
    epoch: s.canon[m].ep,
    prep: s.canon[m].prep,
    confirmed: s.canon[m].bits
      .map((bits, idIdx) => ({ idIdx, id: model.idTable[idIdx], bits }))
      .filter((x) => x.bits),
  });
  return {
    action: action ? { module: action.m, kind: action.kind, index: action.i } : null,
    modules: [fmt(0), fmt(1)],
  };
}

export function analyze(raw, onProgress) {
  const parsed = parseModel(raw);
  if (parsed.errors) return { ok: false, errors: parsed.errors };

  // 现场前缀先按既有持久化语义逐步归约；它是观察记录而非新指令
  const pf = reducePrefix(parsed.model, raw.prefixText);
  if (pf.error) return { ok: false, errors: [pf.error.message], prefixInvalid: true };

  if (!pf.blank && pf.violationIndex !== null) {
    // 前缀本身已形成违约：完整见证从该前缀开始，不再外推尚未发生的交织
    const report = prefixBreachReport(parsed.model, pf);
    return { ok: true, model: publicModel(parsed.model), report };
  }

  const report = explore(parsed.model, onProgress, pf.blank ? null : pf.state);
  if (report.cancelled) return { ok: false, cancelled: true };

  if (!pf.blank && report.violation) {
    // 见证 = 现场前缀 + 从归约态穷尽得到的最短稳定排序后续反例
    report.witnessActions = [
      ...pf.actions.map((a) => ({ m: a.m, kind: a.kind, i: a.i })),
      ...report.witnessActions,
    ];
    report.steps = [...pf.steps, ...report.steps.slice(1)];
    report.prefixLength = pf.actions.length;
    report.prefixSteps = pf.steps;
    report.withinPrefix = false;
  } else if (!pf.blank) {
    report.prefixLength = pf.actions.length;
    report.prefixSteps = pf.steps;
    report.withinPrefix = false;
  }
  return { ok: true, model: publicModel(parsed.model), report };
}

function publicModel(parsed) {
  return {
    keys: parsed.keys,
    moduleIds: parsed.moduleIds,
    idTable: parsed.idTable,
    instructions: parsed.instructions.map((x) => ({
      idx: x.idx,
      lineNo: x.lineNo,
      op: x.op,
      target: x.target,
      arg: x.arg,
      text: x.text,
    })),
  };
}
