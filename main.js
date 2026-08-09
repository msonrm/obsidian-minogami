// Minogami（美濃紙）— プレーンテキスト専用の縦書き編集ビュー。
//
// hechima（IME）とは別のプラグインで、併用を前提にしている。
//
// **なぜ CodeMirror を使わないのか**（2026-08-08 の実測で確定）:
// Obsidian のエディタ（CM6）に `writing-mode: vertical-rl` を当てる方式を Chromebook で
// 試したところ、次の 3 つが壊れた。いずれも CSS では直らない。
//
//   1. タップ位置にキャレットが出ない  → posAtCoords が横書きメトリクスのまま
//   2. 横スクロール量が実体と合わない  → CM6 は文書の「長さ」を**高さ**で持っている（heightmap）
//   3. ↑↓ が上下に行ったり左右に行ったり → cursorLineUp/Down は x 座標で目標桁を保持する
//
// どれも CM6 が自分の責務として持っている測定系で、そこが横書き専用。既存の縦書き
// プラグイン（Tategaki / 猫乃 左手さん）が同じ道から撤退しているのも同じ理由と読める。
//
// そこで **CM6 を使わず、contenteditable を 1 枚持って自前で描く**。これはラボの
// 縦書き検証ページ（https://luffa-lang-labo.dev/tategaki/ ・iPad Safari 実機で
// 既知の不具合ゼロ）と同じ構えで、キャレット・EOF センチネル・矢印の写像・強制再描画は
// そこからの移植。`docs/hechima-tategaki-notes.md` が元の設計ノート。
//
// **スコープ（この版で確かめること）**:
//   - キャレットが打っている場所に正しい形で出るか
//   - タップした場所にキャレットが行くか
//   - 長文で横スクロールと再描画が保つか
// Markdown の装飾は描かない（プレーンテキストとして扱う）。hechima の IME もまだ繋がない
// —— hechima の打鍵横取りは CM6 の拡張として登録されているので、このビューには届かない。
// つまり日本語はシステム IME で入る。それでよい（測りたいのは上の 3 つだけ）。

"use strict";

const { Plugin, TextFileView, Notice, PluginSettingTab, Setting } = require("obsidian");

const VIEW_TYPE = "minogami";

/** 自前キャレットの再測回数（レイアウト未確定で矩形が取れないとき） */
const CARET_RETRY_MAX = 3;

/**
 * 縦組での矢印キーの写像。**見た目の向き → セッションが期待する論理キー**。
 * 論理側は横書き前提（←→ = 文節移動 / ↑↓ = 候補送り）なので 90° 回す。
 *
 * ★**候補送りの向きは「描かれた段の流れ」に追従させる。** 候補窓は空きスペース次第で
 * 左にも右にも出る。固定写像だと、右へフリップしたときにハイライトが逆に動く
 * （iPad 実機 2026-08-09）。文節移動（行に沿う）は流れに関係ないので固定でよい。
 */
function arrowToLogical(key, flowLtr) {
    if (key === "ArrowDown") return "ArrowRight"; // 次の文節
    if (key === "ArrowUp") return "ArrowLeft";    // 前の文節
    if (flowLtr) return key === "ArrowRight" ? "ArrowDown" : "ArrowUp";
    return key === "ArrowLeft" ? "ArrowDown" : "ArrowUp";
}

/** 写像した論理キーを KeyboardEvent 互換の最小形にして渡す（hechima は code/key しか見ない） */
function logicalTap(e, key) {
    return {
        code: key,
        key,
        repeat: e.repeat,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
        preventDefault() {},
    };
}

/**
 * 原稿用紙換算。**文字数を 400 で割ってはいけない。**
 * 原稿用紙は行単位で消費されるので、**短い行も 1 行を占める**（会話文の多い原稿ほど
 * 文字数からの単純換算とずれる）。段落ごとに `ceil(字数 / 20)` 行、空行も 1 行。
 * 20 字 × 20 行 = 400 字詰めが基準（各賞の 30 字 × 40 行などは行長の設定とは別問題）。
 */
const GENKO_CHARS_PER_LINE = 20;
const GENKO_LINES_PER_SHEET = 20;

function countLines(text, perLine) {
    const n = Math.max(1, perLine || GENKO_CHARS_PER_LINE);
    let lines = 0;
    for (const para of text.split("\n")) {
        lines += Math.max(1, Math.ceil(para.length / n));
    }
    return lines;
}

/**
 * キャレットがいま何行目にいるか。
 *
 * ★**折り返し境界では行番号にも「どちら側か」が要る。** 行長 20 でちょうど 20 字目に
 * いるとき、キャレットは 2 行目の先頭に描かれているのに、字数からの単純計算
 * （ceil(20/20) = 1）では 1 行目のままになる。下カーソルで行が変わった瞬間に
 * 行番号だけ動かない、という形で出た（実機 2026-08-09）。
 */
function currentLine(text, off, perLine, downstream) {
    const n = Math.max(1, perLine || GENKO_CHARS_PER_LINE);
    const head = text.slice(0, off);
    const nl = head.lastIndexOf("\n");
    const prev = nl < 0 ? 0 : countLines(head.slice(0, nl), n); // ここまでの段落が使った行
    const k = head.length - (nl + 1);                           // いまの段落で何字目か
    const within = downstream
        ? Math.floor(k / n) + 1              // 境界では次の行の先頭にいる
        : Math.floor(Math.max(0, k - 1) / n) + 1; // 境界では前の行の末尾にいる
    return prev + within;
}

/** 改行を除いた字数（「字数」と言うときに人が数えているもの） */
function countChars(text) {
    return text.replace(/\n/g, "").length;
}

/** 既定の設定。行長 0 = ペインの高さに合わせる */
const DEFAULT_SETTINGS = { lineLength: 0 };

/** 候補窓に一度に並べる件数。**hechima 側の数字キー選択と同じ式**にするため 9 で固定 */
const CAND_WINDOW = 9;

/** アンドゥの保持数。スパイクなので素朴なスナップショット方式 */
const UNDO_MAX = 200;

class TategakiView extends TextFileView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.editorEl = null;
        this.wrapEl = null;
        this.caretEl = null;
        this.statusEl = null;
        this.eofBr = null;
        this.compEl = null;      // 未確定表示（hechima 接続時のみ）
        this.candEl = null;      // 候補窓
        this.lastSegments = null;
        this.imeComposing = false;
        this.candFlowLtr = false; // 候補窓の段の流れ（true = 左→右 = 右へフリップした状態）
        this.candSideRl = null;   // 窓を出した側（開いている間は変えない）
        this.candFocusKey = -1;
        this.hostObj = null;
        this.flashTimer = null;
        this.lineLengthShort = 0; // 行長が画面に入りきらなかったときの実際の字数
        this.statusTimer = null;
        this.pinCaretX = null;   // 行移動で狙う画面上の横位置
        this.pinFrames = 0;
        this.caretRetry = 0;
        this.caretRaf = 0;      // キャレット再描画の rAF 集約
        this.pendingScroll = false;
        this.scrollGuardRaf = 0;   // Safari の飛びを押し戻す追いかけ
        this.scrollGuardUntil = 0;
        this.lastCaretOffset = 0;
        this.goalOffsetY = null; // 行移動で保つ「行に沿った目標位置」（枠の上端からの距離）
        this.caretSide = "upstream"; // 折り返し境界でキャレットをどちらの行に描くか
        this.composing = false; // システム IME の変換中
        this.undoStack = [];
        this.redoStack = [];
        this.snapshotTimer = null;
    }

    getViewType() {
        return VIEW_TYPE;
    }

    getIcon() {
        return "pilcrow";
    }

    getDisplayText() {
        return this.file ? `${this.file.basename}（縦）` : "縦書き";
    }

    // ---- Obsidian との受け渡し（TextFileView の契約） --------------------

    /**
     * 保存されるのはここが返す文字列。**DOM から直に読まず `this.data` を返す**。
     * DOM が空の瞬間（ビュー構築中・ファイル切替中）に保存が走ると、
     * 本物のノートが空で上書きされる。`this.data` は input を観測したときだけ更新する。
     */
    getViewData() {
        return this.data ?? "";
    }

    setViewData(data, clear) {
        this.data = data ?? "";
        try {
            this.renderDoc(clear);
        } catch (e) {
            // ★**本文の読み込みが、飾りの処理で失敗してはいけない。**
            // ここで投げると Obsidian は「ファイルを開くのに失敗しました」を出し、
            // タブが空になる。原因はコンソールに出す
            console.error("minogami: 表示の組み立てに失敗", e);
        }
    }

    renderDoc(clear) {
        this.ensureDom();
        const keep = clear ? 0 : Math.min(this.lastCaretOffset, this.data.length);
        // 1 本のテキストノードとして流し込む（white-space: pre-wrap が改行を保つ）。
        // <br> を作らせないので、offset 系はテキストノードだけ歩けば足りる
        this.editorEl.textContent = this.data;
        this.ensureEofBr();
        if (clear) {
            this.undoStack = [];
            this.redoStack = [];
        }
        if (document.activeElement === this.editorEl) this.setCaretByOffset(keep);
        this.updateStatus();
        this.scheduleCaret(false);
    }

    clear() {
        this.data = "";
        if (this.editorEl) {
            this.editorEl.textContent = "";
            this.ensureEofBr();
        }
    }

    async onOpen() {
        this.ensureDom();
    }

    /**
     * **後片付けは全部やる。** Obsidian はビューを入れ替えるとき、同じリーフの
     * `contentEl` を使い回すことがある。付けたクラスと作った DOM を残すと、
     * 次にそのリーフへ来た Markdown ビューに縦組の残骸が効く（本文が細い帯に潰れ、
     * 自前キャレットが点滅したまま残る、という形で出る）。
     */
    async onClose() {
        this.detachIme();
        this.removeCandidates();
        this.compEl = null;
        if (this.flashTimer) clearTimeout(this.flashTimer);
        this.flashTimer = null;
        if (this.statusTimer) clearTimeout(this.statusTimer);
        this.statusTimer = null;
        if (this.caretRaf) cancelAnimationFrame(this.caretRaf);
        this.caretRaf = 0;
        if (this.scrollGuardRaf) cancelAnimationFrame(this.scrollGuardRaf);
        this.scrollGuardRaf = 0;
        if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
        this.contentEl.removeClass("tategaki-view");
        this.contentEl.empty();
        this.caretEl = null;
        this.editorEl = null;
        this.wrapEl = null;
        this.statusEl = null;
        this.eofBr = null;
    }

    // ---- DOM ------------------------------------------------------------

    ensureDom() {
        if (this.editorEl) return;
        this.contentEl.empty();
        this.contentEl.addClass("tategaki-view");

        this.wrapEl = this.contentEl.createDiv({ cls: "tategaki-wrap" });
        this.editorEl = this.wrapEl.createDiv({ cls: "tategaki-editor" });
        this.statusEl = this.wrapEl.createDiv({ cls: "tategaki-status" });
        this.countEl = this.statusEl.createDiv({ cls: "tategaki-status-count" });
        this.modeEl = this.statusEl.createDiv({ cls: "tategaki-status-mode" });
        this.statusEl.title = "枚数は 20字×20行＝400字詰め換算";

        this.editorEl.setAttribute("contenteditable", "true");
        this.editorEl.setAttribute("spellcheck", "false");
        // iOS / Android のオートコレクトは keydown より後の層で入力を書き換えてくるので、
        // 属性で切っておく（ラボは Pixel の物理キーボードで実害を踏んでいる）
        this.editorEl.setAttribute("autocorrect", "off");
        this.editorEl.setAttribute("autocapitalize", "off");
        this.editorEl.setAttribute("translate", "no");

        this.registerDomEvent(this.editorEl, "keydown", (e) => this.onKeyDown(e));
        this.registerDomEvent(this.editorEl, "beforeinput", (e) => this.onBeforeInput(e));
        this.registerDomEvent(this.editorEl, "input", () => this.onInput());
        this.registerDomEvent(this.editorEl, "paste", (e) => this.onPaste(e));
        this.registerDomEvent(this.editorEl, "compositionstart", () => {
            this.composing = true;
            // 変換中はシステム IME に見せる必要があるので native キャレットを戻す
            this.editorEl.addClass("is-composing");
            this.scheduleCaret(false);
        });
        this.registerDomEvent(this.editorEl, "compositionend", () => {
            this.composing = false;
            this.editorEl.removeClass("is-composing");
            this.syncFromDom();
            this.scheduleCaret(true);
            this.reassertScroll(); // システム IME の確定も native 編集なので同じ手当て
        });
        this.registerDomEvent(this.editorEl, "keyup", (e) => this.hechima()?.handleKeyUp(e));
        this.registerDomEvent(this.editorEl, "focus", () => {
            this.attachIme(); // 焦点がある間だけ宿主を名乗る（CM6 の邪魔をしない）
            this.scheduleCaret(false);
        });
        this.registerDomEvent(this.editorEl, "blur", () => {
            this.detachIme();
            this.scheduleCaret(false);
        });
        // クリック / タップは選択が確定してから測る（dblclick の単語選択は非 collapsed）
        const pointed = (e) => setTimeout(() => {
            this.goalOffsetY = null; // 置き直したキャレットが新しい深さになる
            // 折り返し境界を叩いたときは、**触った列の方**にキャレットを出す
            const x = e?.clientX ?? e?.changedTouches?.[0]?.clientX;
            if (typeof x === "number") {
                const off = this.caretOffset();
                const up = this.sideRect(off, "upstream");
                const dn = this.sideRect(off, "downstream");
                if (up && dn) {
                    const du = Math.abs((up.left + up.right) / 2 - x);
                    const dd = Math.abs((dn.left + dn.right) / 2 - x);
                    this.caretSide = dd < du ? "downstream" : "upstream";
                }
            }
            this.scheduleCaret(false);
        }, 0);
        this.registerDomEvent(this.editorEl, "mouseup", pointed);
        this.registerDomEvent(this.editorEl, "touchend", pointed);

        // スクロール中にプローブ（DOM 変異 + 選択の張り直し）を走らせると、Safari の
        // スクロールクランプと衝突して選択が落ちる → 次フレームに集約する
        let scrollRaf = 0;
        this.registerDomEvent(this.editorEl, "scroll", () => {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                this.scheduleCaret(false);
            });
        });
        this.registerDomEvent(window, "resize", () => this.scheduleCaret(false));

        // 見た目の調整は**配線を終えてから**。ここで転んでも打鍵とキャレットは生き残る
        this.applyLineLength();

        // ★`selectionchange` は**購読しない**。キャレットの実測（measureCaretRect）は
        // プローブ挿入のあと選択を張り直すので、その張り直しが selectionchange を
        // 呼び返して無限ループになる（イベントは非同期に配送されるため、
        // 再入フラグでは止まらない）。ラボが個別イベントだけで済ませていたのはこれが理由。
        // 選択が動く経路は上の keydown / mouseup / touchend / input で網羅している。
    }

    // ---- offset 系（テキストノードだけを歩く） ---------------------------
    //
    // ラボ app.ts からの移植。EOF センチネル（<br>）は SHOW_TEXT に引っかからないので
    // 自然に不可視になる。ここが「文字の位置」の唯一の定義。

    /** 末尾センチネル。contenteditable は末尾に <br> が無いと最終空行の行ボックスを作れず、
     *  末尾の選択が editing host の端という曖昧な位置になって吸われる */
    ensureEofBr() {
        if (!this.eofBr || !this.eofBr.isConnected) {
            this.eofBr = document.createElement("br");
            this.eofBr.className = "tategaki-eof";
        }
        if (this.editorEl.lastChild !== this.eofBr) this.editorEl.appendChild(this.eofBr);
    }

    endOfTextRange() {
        const r = document.createRange();
        if (this.eofBr && this.eofBr.isConnected) {
            r.setStartBefore(this.eofBr);
            r.collapse(true);
        } else {
            r.selectNodeContents(this.editorEl);
            r.collapse(false);
        }
        return r;
    }

    /**
     * 本文のテキストノードを歩く。**未確定表示（compEl）の中は数えない。**
     * 未確定は文書ではないので、オフセットにも保存内容にも現れてはいけない
     * （cb 契約の「文書の所有者はホスト」を DOM の側で守る形）。
     */
    textWalker() {
        return document.createTreeWalker(this.editorEl, NodeFilter.SHOW_TEXT, {
            acceptNode: (n) =>
                this.compEl && this.compEl.contains(n)
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT,
        });
    }

    docText() {
        let out = "";
        const walker = this.textWalker();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) out += n.textContent ?? "";
        return out;
    }

    caretRange() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && this.editorEl.contains(sel.getRangeAt(0).startContainer)) {
            const r = sel.getRangeAt(0).cloneRange();
            r.collapse(false);
            return r;
        }
        return this.endOfTextRange();
    }

    selectRange(r) {
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(r);
    }

    offsetOfPoint(container, offset) {
        const pre = document.createRange();
        pre.selectNodeContents(this.editorEl);
        try {
            pre.setEnd(container, offset);
        } catch {
            return 0; // エディタ外の点
        }
        let out = 0;
        const walker = this.textWalker();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = (n.textContent ?? "").length;
            if (pre.comparePoint(n, 0) > 0) break;
            out += pre.comparePoint(n, len) <= 0 ? len : (n === container ? offset : 0);
            if (n === container) break;
        }
        return out;
    }

    caretOffset() {
        const r = this.caretRange();
        return this.offsetOfPoint(r.startContainer, r.startOffset);
    }

    rangeAt(start, end) {
        const r = document.createRange();
        let acc = 0;
        let started = false;
        const walker = this.textWalker();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const len = (n.textContent ?? "").length;
            if (!started && start <= acc + len) {
                r.setStart(n, start - acc);
                started = true;
            }
            if (started && end <= acc + len) {
                r.setEnd(n, Math.max(0, end - acc));
                return r;
            }
            acc += len;
        }
        if (!started && start === acc) return this.endOfTextRange();
        if (started) {
            if (this.eofBr && this.eofBr.isConnected) r.setEndBefore(this.eofBr);
            else r.setEnd(this.editorEl, this.editorEl.childNodes.length);
            return r;
        }
        return null;
    }

    setCaretByOffset(offset) {
        const r = this.rangeAt(offset, offset);
        if (!r) return;
        // 行移動以外でキャレットが動いたら目標位置は無効（行移動は selectRange を直に使う）
        this.goalOffsetY = null;
        this.caretSide = "upstream"; // 打鍵の直後は「打った文字の後ろ」に出るのが自然
        this.pinCaretX = null;
        this.pinFrames = 0;
        r.collapse(true);
        this.selectRange(r);
        this.lastCaretOffset = offset;
    }

    /** Safari がスクロールクランプ等で選択を落としていたら直近の位置へ戻す */
    ensureSelection() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && this.editorEl.contains(sel.getRangeAt(0).startContainer)) return;
        this.setCaretByOffset(Math.min(this.lastCaretOffset, this.docText().length));
    }

    // ★**再描画を「強制する」仕掛けは持たない。**
    //
    // Safari は縦組で**文字データだけを書き換える**（`insertData` / `deleteData` ＝
    // CharacterData の変異）と再描画矩形を漏らす。症状は 2 つの顔で出た ——
    // 挿入 = 打った字が出てこない / 削除 = 消した字が残像で残る。
    //
    // ラボから移した対策は editing host の style を一瞬揺らすものだったが、
    // **iPad ではこれ自体が害になる**: WebKit は編集領域の style に触られると
    // 「キャレットを見せる」スクロールを連れてきて、**縦組の始端＝右へ寄せる**。
    // 打鍵のたびに表示が右端へ飛んだ（0.1.2 = letter-spacing / 0.1.3 = text-shadow。
    // **レイアウトを動かすかどうかは関係なく、style を触ると出る**）。
    // ← の押しっぱなしで起きるページングと同じ機構で、引き金だけが違う。
    //
    // そこで**漏れない書き方をする**ことにした。ノードが増減する構造変化なら
    // Safari も正しく描くので、挿入は「独立したノードを挿す」、削除は
    // 「消す範囲をノードへ切り出して取り除く」形にしてある（`insertTextAtCaret` /
    // `deleteRange`）。★**壊れた層を下から叩くより、壊れない書き方に寄せる。**

    // ---- 自前キャレット --------------------------------------------------

    /**
     * キャレット位置の実測矩形。
     *
     * ★**DOM を触らずに測るのが最優先**（iPad 実機 2026-08-09 の教訓）。
     * 当初はラボと同じくゼロ幅スペースを挿して測っていたが、挿した後に選択を
     * 張り直す必要があり、その張り直しが**毎フレーム 2 つのものを壊していた**:
     *
     *   - affinity  … 折り返し境界で「前の行の末尾」か「次の行の先頭」かの区別
     *   - goal position … 行移動を続けるときに保つ「行に沿った目標位置」
     *
     * 症状は「→ を押すと一旦その行の下の方へ動いてから右の行に行く」「← が 1 行飛ばす」。
     * ラボが同じ方式で困らなかったのは、あちらが**編集を全部自前で持っていて**
     * ブラウザの行移動に依存していないから。ここでは `sel.modify` に行移動を任せているので、
     * 測定は観測に徹する必要がある。
     *
     * そこで**すでにそこにある 1 文字の矩形**から出す。縦組では文字の下端が
     * その文字の「後ろ」なので、直前の文字の bottom が caret の位置になる。
     * 非 collapsed 範囲の矩形は Safari でも信用できる（プローブ方式自体が
     * 「ノードを選択した非 collapsed 範囲」の矩形を信じていた）。
     * 空行・空文書だけは掴む文字が無いのでプローブに落ちる。
     */
    measureCaretRect() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.isCollapsed ||
            !this.editorEl.contains(sel.getRangeAt(0).startContainer)) {
            return null;
        }
        const off = this.caretOffset();
        const up = this.sideRect(off, "upstream");
        const down = this.sideRect(off, "downstream");
        const first = this.caretSide === "downstream" ? down : up;
        const second = this.caretSide === "downstream" ? up : down;
        return first ?? second ?? this.measureByProbe(off);
    }

    /**
     * キャレットの候補位置を 1 つ測る。**折り返し境界では 2 つの答えがある**:
     *   upstream   = 直前の文字の**下端**（＝前の行の末尾）
     *   downstream = 直後の文字の**上端**（＝次の行の先頭）
     * 折り返していない場所では両者は同じ点になるので、区別が効くのは境界だけ。
     */
    sideRect(off, side) {
        const r = side === "upstream"
            ? (off > 0 ? this.rangeAt(off - 1, off) : null)
            : this.rangeAt(off, off + 1);
        if (!r) return null;
        const t = r.toString();
        if (!t) return null;
        // ★改行の扱いは**側によって違う**。
        //   上流側の "\n" は**前の行の終端**なので、こちらの位置ではない（除く）。
        //   下流側の "\n" は**その行の終端**なので、そのまま位置として使える。
        // 後者を使えるようにしたことで、**空行でもプローブに落ちなくなった** ——
        // 6 万字の文書では、プローブ（DOM を書き換えて縦組を組み直す）が
        // 1 秒級の引っ掛かりになっていた（実機 2026-08-09）
        if (side === "upstream" && t === "\n") return null;
        const b = r.getBoundingClientRect();
        if (!b.width && !b.height) return null;
        return side === "upstream"
            ? new DOMRect(b.left, b.bottom, b.width, 0)
            : new DOMRect(b.left, b.top, b.width, 0);
    }

    /**
     * 目標の列 x に着地したか。着地していれば「どちら側にいるか」を返し、外していれば null。
     *
     * ★**「測れない」を「外れた」と同じ扱いにしない。** ここが例外の温床だった:
     *   - 行頭に着くと upstream は隣の列（前の行の末尾）を指す → downstream も見る
     *   - 空行に着くと**前も後ろも改行**で掴める文字が無い → プローブで直接測る
     *   - それでも測れなければ**着地を信じる**（測定の失敗で移動を潰さない）
     */
    landedIn(x, tol) {
        const off = this.caretOffset();
        const near = (r) => !!r && Math.abs((r.left + r.right) / 2 - x) <= tol;
        const up = this.sideRect(off, "upstream");
        const dn = this.sideRect(off, "downstream");
        if (near(up)) return { side: "upstream", verified: true };
        if (near(dn)) return { side: "downstream", verified: true };
        if (up || dn) return { side: null, verified: true }; // 測れたうえで別の列 = 外している
        // 掴む文字がまったく無い場所（文末の空行など）。ここでプローブを走らせると
        // 長い文書で固まるので、**着地を信じる**。caretRangeFromPoint が返した点なので、
        // そもそも狙った座標にある
        return { side: this.caretSide, verified: false };
    }

    /**
     * ゼロ幅スペースを一瞬挿して測る。掴める文字が無い場所（空行・空文書）で使う唯一の手。
     * ★**測定は状態を変えてはいけない。** 選択を張り直す都合で goal と側が消えるので、
     * 前後で保存して戻す（行移動の途中で空行を通ると目標の深さを失っていた）。
     */
    measureByProbe(o) {
        const keepGoal = this.goalOffsetY;
        const keepSide = this.caretSide;
        const rect = this.probeRect(o);
        this.goalOffsetY = keepGoal;
        this.caretSide = keepSide;
        return rect;
    }

    probeRect(o) {
        const r = this.rangeAt(o, o);
        if (!r) return null;
        r.collapse(true);
        const probe = document.createTextNode("\u200b");
        r.insertNode(probe);
        const pr = document.createRange();
        pr.selectNode(probe);
        const rect = pr.getBoundingClientRect();
        probe.remove();
        this.editorEl.normalize();
        this.setCaretByOffset(o); // プローブで乱れた選択を戻す
        if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
            return null; // レイアウト未確定
        }
        return rect;
    }

    /**
     * キャレットを隠すべき状態か。**「測定に失敗した」は含めない**のが要点。
     * 失敗を隠す理由にすると、キーリピート中のように測定が落ちやすい場面で
     * キャレットが消えてしまう（実機 2026-08-08）。失敗のときは前の位置を残す。
     */
    caretHidden() {
        if (this.composing || this.imeComposing) return true;
        if (document.activeElement !== this.editorEl) return true;
        const sel = window.getSelection();
        return !sel || sel.rangeCount === 0 || !sel.isCollapsed ||
            !this.editorEl.contains(sel.getRangeAt(0).startContainer);
    }

    /**
     * 1 フレームに 1 回だけ測って描く。**プローブ（DOM 変異）を連打しない**ための集約点。
     * キーリピートは毎秒 30 回来るので、押下ごとに測ると測定自体が落ちる。
     * scroll = true なら追従も同じフレームで行う（測り直しは移動したときだけ）。
     */
    scheduleCaret(scroll) {
        if (scroll) this.pendingScroll = true;
        if (this.caretRaf) return;
        this.caretRaf = requestAnimationFrame(() => {
            this.caretRaf = 0;
            const wantScroll = this.pendingScroll;
            this.pendingScroll = false;
            this.scheduleStatus();
            this.updateCaret(wantScroll);
        });
    }

    updateCaret(scroll) {
        if (!this.editorEl) return;
        if (!this.caretEl) {
            this.caretEl = this.wrapEl.createDiv({ cls: "tategaki-caret" });
        }
        // 変換中は native キャレットに任せる（システム IME の未確定表示と二重になるため）
        if (this.caretHidden()) {
            this.caretEl.style.display = "none";
            return;
        }
        let rect = this.measureCaretRect();
        if (rect && scroll) {
            // 狙いの画面位置が指定されていればそれを優先。無ければ「枠の外なら戻す」
            const moved = this.pinFrames > 0 ? this.enforcePin(rect) : this.scrollToRect(rect);
            if (moved) rect = this.measureCaretRect() ?? rect;
        }
        if (this.pinFrames > 0 && --this.pinFrames > 0) {
            requestAnimationFrame(() => this.scheduleCaret(true));
        }
        if (!rect) {
            // 測れなかっただけ。**隠さずに**前の位置を残し、次フレームで測り直す
            if (this.caretRetry < CARET_RETRY_MAX) {
                this.caretRetry++;
                requestAnimationFrame(() => this.updateCaret(false));
            }
            return;
        }
        this.caretRetry = 0;
        const box = this.editorEl.getBoundingClientRect();
        const fs = parseFloat(getComputedStyle(this.editorEl).fontSize) || 18;
        const w = Math.min(rect.width || fs, fs);
        const left = Math.min(
            Math.max(rect.left + (rect.width > w ? (rect.width - w) / 2 : 0), box.left),
            box.right - w,
        );
        const top = Math.min(Math.max(rect.top, box.top + 2), box.bottom - 4);
        const host = this.wrapEl.getBoundingClientRect();
        this.caretEl.style.display = "";
        this.caretEl.style.left = `${left - host.left}px`;
        this.caretEl.style.top = `${top - host.top}px`;
        this.caretEl.style.width = `${w}px`;
        // 点滅は移動のたびに先頭から（実 IME キャレットの作法）
        this.caretEl.style.animation = "none";
        void this.caretEl.offsetWidth;
        this.caretEl.style.animation = "";
    }

    /**
     * キャレットを横スクロール範囲に入れる。programmatic な Range 操作では
     * contenteditable の自動追従が効かない。相対量で動かすので、
     * vertical-rl の scrollLeft 符号方言（0 = 右端・左へ負）に依存しない
     */
    /**
     * キャレットを**狙った画面位置に置く**。「枠の外なら戻す」では足りない ——
     * ブラウザは選択が動くと自前でもスクロールし、長い縦組では**ページ単位で飛ぶ**。
     * 飛んだ先も枠の中なので「外なら戻す」方式では検知できず、そのまま残る
     * （← の押しっぱなしで毎回ページングして見えた / 実機 2026-08-09）。
     * しかもそれは**こちらの同期処理より後のフレームで**来るので、数フレーム押し通す。
     */
    enforcePin(known) {
        if (this.pinCaretX == null || !this.editorEl) return false;
        const rect = known ?? this.measureCaretRect();
        if (!rect) return false;
        const cx = (rect.left + rect.right) / 2;
        if (Math.abs(cx - this.pinCaretX) <= 1) return false;
        this.editorEl.scrollLeft += cx - this.pinCaretX;
        return true;
    }

    scrollToRect(rect) {
        const MARGIN = 24;
        const box = this.editorEl.getBoundingClientRect();
        if (rect.left < box.left) {
            this.editorEl.scrollLeft -= box.left - rect.left + MARGIN;
            return true;
        }
        if (rect.right > box.right) {
            this.editorEl.scrollLeft += rect.right - box.right + MARGIN;
            return true;
        }
        return false;
    }

    // ---- 編集 ------------------------------------------------------------

    /** DOM の実体を this.data に写して保存を予約する */
    syncFromDom() {
        // ファイルが外れている瞬間（切替中・破棄後）は書き戻さない。
        // 相手が居ない状態の保存は、別のノートを上書きしうる唯一の経路
        if (!this.file || !this.editorEl) return;
        this.ensureEofBr();
        const text = this.docText();
        if (text === this.data) return;
        this.data = text;
        this.requestSave();
        this.scheduleStatus();
    }

    snapshot() {
        this.undoStack.push({ text: this.data ?? this.docText(), caret: this.caretOffset() });
        if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
        this.redoStack = [];
    }

    /** 素の入力（native の insertText）は連続するので、間が空いたときだけ 1 段積む */
    snapshotCoalesced() {
        if (this.snapshotTimer) {
            clearTimeout(this.snapshotTimer);
        } else {
            this.snapshot();
        }
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
        }, 600);
    }

    restore(from, to) {
        const s = from.pop();
        if (!s) return false;
        to.push({ text: this.docText(), caret: this.caretOffset() });
        this.editorEl.textContent = s.text;
        this.ensureEofBr();
        this.setCaretByOffset(Math.min(s.caret, s.text.length));
        this.syncFromDom();
        // 本文ごと置き換える（＝構造変化）ので、再描画はブラウザが自分で行う
        this.scheduleCaret(false);
        return true;
    }

    insertTextAtCaret(text) {
        const r = this.caretRange();
        r.deleteContents();
        // ★**独立したテキストノードとして挿す（＝構造変化）。`insertData` は使わない。**
        // Safari は文字データだけを書き換えると再描画を漏らす（打った字が出てこない）が、
        // ノードが増減するときは正しく描く。**塗りを揺らして補うのは駄目**で、
        // editing host の style に触ると WebKit が「キャレットを見せる」スクロールを
        // 連れてきて、打鍵のたびに表示が右端へ飛ぶ（0.1.2 / 0.1.3 の実機で確認）。
        //
        // `normalize()` はしない —— 6 万字で重かったのは**毎打鍵で巨大なテキストノードを
        // 作り直す**ことで、分割そのものは安い。ノードは削除・未確定の消去・再変換の
        // ときに merge される。分割の仕方も、末尾／先頭なら**分割せず隣に挿す**ので、
        // 続けて打っている間は 1 打鍵 = 1 ノードで済む（空ノードも作らない）
        const node = r.startContainer;
        const tn = document.createTextNode(text);
        if (node.nodeType === 3) {
            if (r.startOffset >= node.length) node.after(tn);
            else if (r.startOffset === 0) node.before(tn);
            else {
                node.splitText(r.startOffset);
                node.after(tn);
            }
        } else {
            r.insertNode(tn);
        }
        const after = document.createRange();
        after.setStart(tn, text.length);
        after.collapse(true);
        this.selectRange(after);
        this.lastCaretOffset = this.caretOffset();
    }

    /**
     * 範囲を消す。1 つのテキストノードに収まるときは、消す範囲を**自分のノードへ
     * 切り出して取り除く**（＝構造変化）。`deleteData` で削るだけだと Safari が
     * 再描画を漏らし、消したはずの字が残像で残る —— 挿入側と同じ 1 つのバグで、
     * 直し方も同じ（**style は触らない**。触ると reveal のスクロールが付いてくる）。
     */
    deleteRange(r, caretAt) {
        if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) {
            const node = r.startContainer;
            const mid = node.splitText(r.startOffset);         // [前][消す + 後]
            const tail = mid.splitText(r.endOffset - r.startOffset); // [前][消す][後]
            mid.remove();
            // 空になったノードは残さない（歩き回るコードは通せるが、溜めても得が無い）
            if (!node.length) node.remove();
            if (!tail.length) tail.remove();
            this.setCaretByOffset(caretAt);
            return;
        }
        r.deleteContents();
        this.editorEl.normalize();
        this.setCaretByOffset(caretAt);
    }

    deleteAround(back) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        if (!sel.isCollapsed) {
            // 選択の削除も deleteRange に通す（1 ノードに収まるときの残像対策は同じ）
            const r = sel.getRangeAt(0);
            this.deleteRange(r, this.offsetOfPoint(r.startContainer, r.startOffset));
            return;
        }
        const off = this.caretOffset();
        const text = this.docText();
        if (back) {
            if (off <= 0) return;
            // サロゲートペア（絵文字等）を割らない
            const prev = text.slice(0, off);
            const n = /[\uDC00-\uDFFF]$/.test(prev) && prev.length >= 2 ? 2 : 1;
            const r = this.rangeAt(off - n, off);
            if (!r) return;
            this.deleteRange(r, off - n);
        } else {
            if (off >= text.length) return;
            const next = text.slice(off);
            const n = /^[\uD800-\uDBFF]/.test(next) && next.length >= 2 ? 2 : 1;
            const r = this.rangeAt(off, off + n);
            if (!r) return;
            this.deleteRange(r, off);
        }
    }

    // ---- 行移動 ----------------------------------------------------------

    /**
     * 行を 1 つ移る（縦組では**前の行 = 右 / 次の行 = 左**）。
     *
     * ★**ブラウザの `sel.modify(..., "line")` は使わない。** 折り返し境界のオフセットは
     * 「前の行の末尾」と「次の行の先頭」の両方を指しうる（affinity）。ブラウザは後者だと
     * 思っていて、こちらは前者に描くので 1 列ずれ、← が 2 行進んで見えた
     * （iPad 実機 2026-08-09）。**どちら側にいるかを読む API は無い。**
     *
     * そこで**描かれているキャレットを基準に幾何で動かす**。見えているものが正になるので
     * affinity は関係なくなる。行に沿った目標位置（goal）も自前で保つ ——
     * 短い行を通り過ぎても元の深さに戻れる、という普通のエディタの挙動はこれで出る。
     *
     * これで**ブラウザに委ねている編集動作はゼロ**になった。ラボの結論
     * 「縦書きは、表示の縦組だけ CSS に任せ、残りをホストが全部引き取るときだけ成立する」
     * に、別の入口から同じ形で到達したことになる。
     */
    moveLine(sel, alter, backward) {
        this.moveColumns(sel, alter, backward, 1);
    }

    /** N 列ぶん移る。行移動は N=1、ページ送りは「画面に入る列数 − 1」 */
    moveColumns(sel, alter, backward, n) {
        const rect = this.measureCaretRect();
        if (!rect || typeof document.caretRangeFromPoint !== "function") {
            sel.modify(alter, backward ? "backward" : "forward", "line");
            return;
        }
        const box = this.editorEl.getBoundingClientRect();
        // 行に沿った目標位置は**枠の上端からの距離**で持つ（横スクロールでは変わらない）
        if (this.goalOffsetY === null) this.goalOffsetY = rect.top - box.top;

        const step = this.columnStep();
        const dist = step * Math.max(1, n);
        const aim = (r) => (r.left + r.right) / 2 + (backward ? dist : -dist);

        let x = aim(rect);
        if (x < box.left + 1 || x > box.right - 1) {
            // 目標の行がまだ画面に無い → 1 列ぶんスクロールしてから測り直す
            this.editorEl.scrollLeft += x < box.left ? -(box.left - x + step) : (x - box.right + step);
            const moved = this.measureCaretRect();
            if (!moved) return;
            x = aim(moved);
            if (x < box.left || x > box.right) return; // 文書の端
        }
        const y = Math.min(Math.max(box.top + this.goalOffsetY, box.top + 1), box.bottom - 1);

        const before = this.caretOffset();
        const target = document.caretRangeFromPoint(x, y);
        if (!target || !this.editorEl.contains(target.startContainer)) return;
        if (alter === "extend") {
            sel.extend(target.startContainer, target.startOffset);
        } else {
            target.collapse(true);
            this.selectRange(target); // setCaretByOffset は使わない（goal を消さないため）
        }
        this.lastCaretOffset = this.caretOffset();

        // 狙った列に入ったかを確かめる。短い行の末尾などで別の列へ飛ぶことがあるので、
        // ずれていたら**動かなかったことにする**（不意の飛びを作らない）。
        // ★判定は upstream / downstream の両方で行う —— 行頭に着いたときは
        // downstream しか目標の列に無い（upstream は前の行の末尾＝隣の列）
        // ★向きの検算。← は文書の先へ、→ は手前へ進むはずで、逆に着いたら取り消す。
        // 空行に着地したときは掴める文字が無く列の照合ができないため着地を信じる作りに
        // してあり、その穴から**遠くの行へ飛ぶ**ことがあった（実機 2026-08-09）。
        // 位置の照合が使えない場面でも、文字の並び順は必ず使える
        const after = this.caretOffset();
        const wrongWay = backward ? after > before : after < before;
        // ★**進める距離にも上限がある。** 1 列ぶんの移動で動く字数は、長くても
        // 「いまの行の残り + 次の行の目標位置」= 行長の 2 倍まで。向きだけを見ていると、
        // 空行に着地して列の照合が効かないときに**遠くへ飛んだものが通ってしまう**
        // 行長は**全角での字数**。半角ばかりの行は倍近く入るので、
        // 「いまの行の残り + 次の行の目標位置」は行長の 4 倍まで見込む
        // （狭くすると、半角の多い行で正しい移動まで差し戻される / 実機 2026-08-09）
        const limit = (this.charsPerLine() * 4 + 16) * Math.max(1, n);
        const tooFar = Math.abs(after - before) > limit;
        // ★距離の上限は**列の照合ができなかったときだけ**効かせる。
        // 照合が通っているなら狙った列に居るのは確かで、そこへ何字進んだかは
        // 行の中身（半角の割合）次第。両方に効かせると、半角の多い行で
        // 正しい移動まで差し戻された（実機 2026-08-09）
        const { side, verified } = this.landedIn(x, step * 0.75);
        if (alter !== "extend" && (!side || wrongWay || (!verified && tooFar))) {
            this.setCaretByOffset(before);
            this.goalOffsetY = null;
            return;
        }
        if (side) this.caretSide = side; // 描画も着地した側に合わせる

        // ★スクロールは**明示的に決めて上書きする**。選択が動くとブラウザも自前で
        // 「キャレットを見せる」スクロールをするが、長い縦組では**ページ単位で飛ぶ**。
        // こちらの追従は「枠の外に出ていたら戻す」だけなので、枠の中に収まっている限り
        // 何も直さず、飛んだままになる —— 押しっぱなしで 1 行ずつ進むはずが、
        // 断続的にページが送られたように見えた（実機 2026-08-09）。
        // 狙った画面位置にキャレットが来るよう、こちらで座標を合わせる
        const wantX = Math.min(Math.max(x, box.left + 24), box.right - 24);
        this.pinCaretX = wantX;
        this.pinFrames = 2; // ブラウザの自動スクロールは**後のフレームで**来る
        this.enforcePin();
    }

    /**
     * 行長（1 行の字数）を反映する。**縦組では height が行長**。
     * 全角は 1 字 = 1em なので em がそのまま字数になる。padding のぶんを足しているのは
     * box-sizing: border-box にしてあるため。0 のときはペインの高さいっぱい。
     */
    applyLineLength() {
        if (!this.editorEl) return;
        const n = Number(this.plugin?.settings?.lineLength) || 0;
        if (n <= 0) {
            this.editorEl.style.flex = "";
            this.editorEl.style.height = "";
            this.scheduleCaret(true);
            return;
        }
        // ★`calc(Nem + padding)` は端末ごとに 1 字ずれた（Chromebook で 1 字足りず、
        // iPad で 1 字多い / 2026-08-09）。**全角 1 字 = 1em は保証されていない**し、
        // px への丸め方も端末で違う。書体から**実測**して px で置く。
        const adv = this.measureCharAdvance();
        this.charAdvance = adv; // 行数の勘定でも使う（毎回測り直さない）
        const cs = getComputedStyle(this.editorEl);
        const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        // 半字に満たない余白を足す = 丸めで 1 字落ちるのを防ぎ、1 字増えることもない
        // **縮められる**ようにしておく（flex: none だと画面をはみ出し、
        // ステータス行が画面外へ押し出される）。入りきらないときは自動で折り返し、
        // 「指定より短い」ことを下に出す
        this.editorEl.style.flex = "0 1 auto";
        let h = n * adv + adv * 0.4 + pad;
        this.editorEl.style.height = `${Math.round(h)}px`;

        // ★置いた高さに**実際に何字入るか**を測って合わせ込む。
        // 計算だけでは合わない要因がある: デスクトップの Chrome は横スクロールバーが
        // **内側の高さを削る**（iPad は重ねて描くので削らない）。これが
        // 「Chromebook だけ 1 字足りない」の正体。max-height での頭打ちもここで吸収する。
        for (let i = 0; i < 3; i++) {
            const fit = this.charsPerLine();
            if (fit === n) break;
            h += (n - fit) * adv;
            this.editorEl.style.height = `${Math.round(h)}px`;
        }
        // 画面の高さが足りず、指定の行長に届かなかったか
        const fit = this.charsPerLine();
        this.lineLengthShort = fit < n ? fit : 0;
        this.updateStatus();
        this.scheduleCaret(true);
    }

    /** いま 1 行に実際に入る全角の字数（枠の内側の高さ ÷ 1 字の送り幅） */
    charsPerLine() {
        if (!this.editorEl) return GENKO_CHARS_PER_LINE;
        const cs = getComputedStyle(this.editorEl);
        // clientHeight は**スクロールバーを除いた**内寸。ここが計算との差になる
        const inner = this.editorEl.clientHeight -
            (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
        const adv = this.charAdvance ?? this.measureCharAdvance();
        return Math.max(1, Math.floor((inner + 0.5) / adv));
    }

    /**
     * 全角 1 字の送り幅（縦組では字が縦に進むので、その高さ）を実測する。
     * 本文の contenteditable は触らず、枠の側に隠しプローブを置いて書体だけ写す。
     */
    measureCharAdvance() {
        const cs = getComputedStyle(this.editorEl);
        const probe = document.createElement("span");
        probe.textContent = "あ".repeat(20);
        probe.style.cssText =
            "position:absolute;visibility:hidden;white-space:nowrap;writing-mode:vertical-rl;top:0;left:0;";
        for (const k of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing"]) {
            probe.style[k] = cs[k];
        }
        this.wrapEl.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return h > 0 ? h / 20 : parseFloat(cs.fontSize) || 16;
    }

    /** 1 列ぶんの送り幅（縦組では line-height が列の間隔になる） */
    columnStep() {
        const cs = getComputedStyle(this.editorEl);
        return parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 18) * 1.9;
    }

    /** ページ送りで動く列数。**1 列だけ重ねて残す**（読んでいた場所との繋がりが切れない） */
    columnsPerPage() {
        const cs = getComputedStyle(this.editorEl);
        const inner = this.editorEl.clientWidth -
            (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        return Math.max(1, Math.floor(inner / this.columnStep()) - 1);
    }

    /**
     * ページ送り。**列を N 個ぶん動かすのではなく、1 ページぶんスクロールしてから
     * 同じ画面位置を拾う。** 列送りでやると、目標が画面外に出たときのスクロールが
     * 端で頭打ちになり「ページ内でキャレットだけ右端へ動く」ことがあった（実機 2026-08-09）。
     * めくって同じ場所を見る、という紙の動きに合わせた方が破綻しない。
     */
    movePage(sel, alter, backward) {
        const rect = this.measureCaretRect();
        if (!rect || typeof document.caretRangeFromPoint !== "function") return;
        const box = this.editorEl.getBoundingClientRect();
        if (this.goalOffsetY === null) this.goalOffsetY = rect.top - box.top;
        const dx = (rect.left + rect.right) / 2 - box.left; // 画面内での横位置を保つ
        const page = this.columnsPerPage() * this.columnStep();
        const before = this.editorEl.scrollLeft;
        this.editorEl.scrollLeft += backward ? page : -page; // 縦組は右が先頭
        if (this.editorEl.scrollLeft === before && alter === "move") {
            // もう端。文頭 / 文末へ寄せる（普通のエディタの作法）
            this.setCaretByOffset(backward ? 0 : this.docText().length);
            return;
        }
        const x = Math.min(Math.max(box.left + dx, box.left + 1), box.right - 1);
        const y = Math.min(Math.max(box.top + this.goalOffsetY, box.top + 1), box.bottom - 1);
        const target = document.caretRangeFromPoint(x, y);
        if (!target || !this.editorEl.contains(target.startContainer)) return;
        if (alter === "extend") {
            sel.extend(target.startContainer, target.startOffset);
        } else {
            target.collapse(true);
            this.selectRange(target);
        }
        this.lastCaretOffset = this.caretOffset();
        // ★着地した側に描画を合わせる。ここを忘れると、折り返しの行頭に着いたのに
        // 前の行の末尾に描かれる（「ページ移動すると行末に出る」の正体）
        const { side } = this.landedIn(x, this.columnStep() * 0.75);
        if (side) this.caretSide = side;
    }

    /**
     * 行頭 / 行末へ（Home / End）。**見た目の行**の端に行く。
     * 列は枠の内側いっぱいの高さを持つので、その上端・下端を指せばよい。
     * 短い行では文字の無い所を指すことになるが、ブラウザはその列の最寄りを返す = 行末。
     */
    moveToLineEdge(sel, alter, toEnd) {
        const rect = this.measureCaretRect();
        if (!rect || typeof document.caretRangeFromPoint !== "function") return;
        const cs = getComputedStyle(this.editorEl);
        const box = this.editorEl.getBoundingClientRect();
        const x = (rect.left + rect.right) / 2;
        const y = toEnd
            ? box.bottom - (parseFloat(cs.paddingBottom) || 0) - 1
            : box.top + (parseFloat(cs.paddingTop) || 0) + 1;
        const target = document.caretRangeFromPoint(x, y);
        if (!target || !this.editorEl.contains(target.startContainer)) return;
        if (alter === "extend") {
            sel.extend(target.startContainer, target.startOffset);
        } else {
            target.collapse(true);
            this.selectRange(target);
        }
        this.lastCaretOffset = this.caretOffset();
        this.goalOffsetY = null;
        // 行頭は「次の行の先頭」側、行末は「前の行の末尾」側に描く
        this.caretSide = toEnd ? "upstream" : "downstream";
    }

    /**
     * Safari は native 編集のあと、壊れた縦書きキャレット矩形へ向けて
     * 「キャレットを見せるための」スクロールを**非同期に**行う。その結果、
     * 文字を打つたびに表示が文末（＝一番左のページ）へ飛ぶ（iPad 実機 2026-08-09。
     * ラボの Safari バグカタログ #5 と同じもの）。
     *
     * こちらの scrollIntoView は編集と同じフレームで走るので、後から来る飛びに負ける。
     * そこで**しばらく追いかけて押し戻す**。編集が終われば止まるので、
     * 利用者が自分でスクロールしたときに引き戻すことはない。
     */
    reassertScroll() {
        this.scrollGuardUntil = performance.now() + 150;
        if (this.scrollGuardRaf) return;
        const tick = () => {
            this.scrollGuardRaf = 0;
            if (!this.editorEl) return;
            const rect = this.measureCaretRect();
            if (rect) this.scrollToRect(rect);
            if (performance.now() < this.scrollGuardUntil) {
                this.scrollGuardRaf = requestAnimationFrame(tick);
            }
        };
        this.scrollGuardRaf = requestAnimationFrame(tick);
    }

    // ---- hechima 接続（ホストとして名乗る） -------------------------------
    //
    // hechima の打鍵横取りは CM6 の拡張として登録されているので、このビューには届かない。
    // そこで **こちらから hechima を呼ぶ**。hechima 側には `setHost()` の口があり、
    // ホストは「Obsidian Editor の部分互換」と「未確定・候補の描画」を提供すればよい。
    // cb 契約が元から「文書の所有者はホスト」なので、宿主を替えるだけで筋が通る。

    /** 入っていれば hechima の IME を返す（入っていなければシステム IME のまま動く） */
    hechima() {
        const ime = this.app.plugins?.plugins?.hechima?.ime ?? null;
        return ime && typeof ime.setHost === "function" ? ime : null;
    }

    attachIme() {
        const ime = this.hechima();
        if (!ime) return;
        if (!this.hostObj) this.hostObj = this.buildHost();
        ime.setHost(this.hostObj);
    }

    detachIme() {
        const ime = this.hechima();
        if (ime && ime.host === this.hostObj) ime.setHost(null);
    }

    /** hechima に渡すホスト。Obsidian Editor の部分互換 + 表示 4 種 */
    buildHost() {
        const v = this;
        return {
            editor: {
                getCursor: () => v.offsetToPos(v.caretOffset()),
                setCursor: (pos) => v.setCaretByOffset(v.posToOffset(pos)),
                posToOffset: (pos) => v.posToOffset(pos),
                offsetToPos: (off) => v.offsetToPos(off),
                getRange: (from, to) => v.docText().slice(v.posToOffset(from), v.posToOffset(to)),
                replaceRange: (text, from, to) =>
                    v.replaceOffsets(v.posToOffset(from), v.posToOffset(to), text),
                getSelection: () => v.selectedText(),
                replaceSelection: (text) => v.replaceSelectionText(text),
            },
            show: (segments) => v.showComposing(segments),
            hide: () => v.hideComposing(),
            flashMode: (text) => v.flashMode(text),
            hasCandidates: () =>
                !!v.lastSegments?.find((sg) => sg.kind === "focus")?.candidates?.length,
        };
    }

    // ---- 位置と文書操作（Editor 互換の下回り） ----------------------------

    offsetToPos(off) {
        const head = this.docText().slice(0, Math.max(0, off)).split("\n");
        return { line: head.length - 1, ch: head[head.length - 1].length };
    }

    posToOffset(pos) {
        const lines = this.docText().split("\n");
        let off = 0;
        for (let i = 0; i < pos.line && i < lines.length; i++) off += lines[i].length + 1;
        return off + Math.min(pos.ch, lines[pos.line]?.length ?? 0);
    }

    selectedText() {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
        if (!this.editorEl.contains(sel.getRangeAt(0).startContainer)) return "";
        return sel.getRangeAt(0).toString();
    }

    replaceOffsets(from, to, text) {
        this.snapshotCoalesced(); // ホスト経由の変更もアンドゥに積む
        const r = this.rangeAt(from, to);
        if (!r) return;
        // 消すのも挿すのも**構造を変える形**に通す。ここは再変換と確定アンドゥの経路で、
        // 削除だけになることもある（＝残像が出やすい側）
        if (from !== to) this.deleteRange(r, from);
        else this.setCaretByOffset(from);
        if (text) this.insertTextAtCaret(text);
        this.syncFromDom();
        this.scheduleCaret(true);
    }

    replaceSelectionText(text) {
        this.snapshotCoalesced(); // ホスト経由の変更もアンドゥに積む
        // 未確定表示があるときは**その直前**に入れる（確定はその位置で起きる）。
        // 直後に hide() が来て未確定が消え、キャレットは入れた文字の後ろに残る
        if (this.compEl && this.compEl.isConnected) {
            const tn = document.createTextNode(text);
            this.compEl.parentNode.insertBefore(tn, this.compEl);
            const after = document.createRange();
            after.setStartAfter(tn);
            after.collapse(true);
            this.selectRange(after);
            this.syncFromDom();
            return;
        }
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed &&
            this.editorEl.contains(sel.getRangeAt(0).startContainer)) {
            sel.getRangeAt(0).deleteContents();
            this.editorEl.normalize();
            this.setCaretByOffset(this.caretOffset());
        }
        this.insertTextAtCaret(text);
        this.syncFromDom();
        this.scheduleCaret(true);
    }

    // ---- 未確定表示 ------------------------------------------------------

    /**
     * 未確定を**本文と同じ流れの中に**描く。ここが縦書き IME の肝で、
     * 未確定が本文と一緒に CSS で縦に組まれるからこそ縦書きのまま入力できる
     * （OS の IME に任せると、未確定だけ横書きの世界から割り込んでくる）。
     * 文書には書かない —— compEl は textWalker が数えないので保存内容に出ない。
     */
    showComposing(segments) {
        if (!this.editorEl) return;
        this.imeComposing = true;
        this.lastSegments = segments;
        if (!this.compEl || !this.compEl.isConnected) {
            this.compEl = document.createElement("span");
            this.compEl.className = "tategaki-comp";
            const off = this.caretOffset();
            const r = this.rangeAt(off, off);
            if (r) {
                r.collapse(true);
                r.insertNode(this.compEl);
            } else {
                this.editorEl.appendChild(this.compEl);
            }
            const before = document.createRange();
            before.setStartBefore(this.compEl);
            before.collapse(true);
            this.selectRange(before); // 挿入点 = 未確定の直前
        }
        this.compEl.textContent = "";
        for (const seg of segments) {
            const el = document.createElement("span");
            el.className = `tategaki-seg-${seg.kind}`;
            el.textContent = seg.text;
            this.compEl.appendChild(el);
        }
        this.renderCandidates(segments);
        const rect = this.compEl.getBoundingClientRect();
        if (rect.width || rect.height) this.scrollToRect(rect);
        this.scheduleCaret(false); // 未確定中は自前キャレットを出さない
    }

    hideComposing() {
        this.imeComposing = false;
        this.lastSegments = null;
        this.candSideRl = null;
        this.candFocusKey = -1;
        this.removeCandidates();
        if (this.compEl) {
            const off = this.caretOffset();
            this.compEl.remove();
            this.compEl = null;
            this.editorEl?.normalize();
            this.setCaretByOffset(off);
        }
        this.syncFromDom();
        this.scheduleCaret(true);
    }

    flashMode(text) {
        if (!this.modeEl) return;
        this.modeEl.setText(text);
        this.modeEl.addClass("is-flash");
        if (this.flashTimer) clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => {
            this.flashTimer = null;
            this.modeEl?.removeClass("is-flash");
            this.updateStatus();
        }, 1300);
    }

    // ---- 候補窓（縦組） --------------------------------------------------

    removeCandidates() {
        this.candEl?.remove();
        this.candEl = null;
        this.candColsEl = null;
    }

    /**
     * 候補窓を**縦組で**、注目文節のすぐ隣に出す（ラボ /tategaki/ の近接アンカー）。
     *
     * 段組は「横 flex の各段に writing-mode」方式。コンテナ自体を縦にすると
     * 直交フロー（横親の中の縦ブロック）の自動サイズ計算になり、iPad Safari で崩れる。
     *
     * 出す側は空きスペースで決める。**左に出れば段は右→左**（第一候補が文節の隣）、
     * 右へフリップすれば左→右。不変則は「第一候補 = 注目文節のすぐ隣」。
     * 番号は窓内の優先順（1-9）で、hechima 側の数字キー選択と同じ式になる。
     */
    renderCandidates(segments) {
        const focus = segments.find((s) => s.kind === "focus");
        const cands = focus?.candidates;
        const idxRaw = focus?.candidateIndex ?? 0;
        const inAdditional = focus?.additionalIndex !== undefined;
        const page = Math.floor(idxRaw / CAND_WINDOW);
        // 追加候補（ひらがな/カタカナ等）は 1 ページ目でだけ見せる
        const additional = inAdditional || page === 0 ? focus?.additional ?? [] : [];
        if (!cands || (cands.length < 2 && !additional.length)) {
            this.removeCandidates();
            return;
        }
        const start = page * CAND_WINDOW;
        const shown = cands.slice(start, start + CAND_WINDOW);
        const pages = Math.ceil(cands.length / CAND_WINDOW);

        // 注目文節が移ったら別の窓なので、向きは決め直す
        const focusKey = segments.findIndex((sg) => sg.kind === "focus");
        if (focusKey !== this.candFocusKey) {
            this.candFocusKey = focusKey;
            this.candSideRl = null;
        }
        this.removeCandidates();
        const el = this.wrapEl.createDiv({ cls: "tategaki-cands" });
        this.candEl = el;
        // 段（候補）の並びとフッタ（ページ位置）は別の箱にする。
        // フッタは候補窓の**下**に、区切り線を挟んで横書きのまま置く
        const cols = el.createDiv({ cls: "tategaki-cand-cols" });
        this.candColsEl = cols;

        // ★追加候補は**流れの起点側**に置く（横書き版が「通常候補の上」に出すのと同じ位置）。
        // 縦組では起点 = 注目文節の隣なので、左に出た窓なら右端、右にフリップしたなら左端。
        // 後ろに付けると「文節から一番遠い端」に出てしまい、違和感になる（実機の指摘）
        additional.forEach((a, i) => {
            const col = cols.createDiv({
                cls: "tategaki-cand is-additional" +
                    (inAdditional && i === focus.additionalIndex ? " is-sel" : ""),
            });
            col.createSpan({ cls: "tategaki-cand-num", text: a.annotation ?? "" });
            col.createSpan({ cls: "tategaki-cand-body", text: a.text });
        });
        if (additional.length && shown.length) {
            cols.createDiv({ cls: "tategaki-cand-divider" });
        }
        shown.forEach((text, i) => {
            const abs = start + i;
            const col = cols.createDiv({
                cls: "tategaki-cand" + (!inAdditional && abs === idxRaw ? " is-sel" : ""),
            });
            col.createSpan({ cls: "tategaki-cand-num", text: String(i + 1) });
            col.createSpan({ cls: "tategaki-cand-body", text });
            col.addEventListener("mousedown", (ev) => {
                ev.preventDefault(); // フォーカスを本文に残す
                this.hechima()?.selectCandidate(abs);
            });
        });
        // ★ページ位置は**数字**で出す。横書き版は点列（数えずに掴める）を使っているが、
        // 縦組では使えない —— **点列は左→右という向きを暗黙に持つのに、この窓は
        // 出る側で段の流れが反転する**ので、必ずどちらかでハイライトの進む向きと
        // 食い違う（実機 2026-08-09）。数字に向きは無い。
        // 1 ページに収まるならフッタごと出さない（情報がゼロなので）
        if (pages > 1) {
            el.createDiv({ cls: "tategaki-cand-foot", text: `${page + 1}/${pages}` });
        }

        this.placeCandidates();
    }

    placeCandidates() {
        const el = this.candEl;
        const seg = this.compEl?.querySelector(".tategaki-seg-focus") ?? this.compEl;
        if (!el || !seg) return;
        const GAP = 6;
        const segRect = seg.getBoundingClientRect();
        const box = this.editorEl.getBoundingClientRect();
        const host = this.wrapEl.getBoundingClientRect();
        const w = el.offsetWidth;
        const h = el.offsetHeight;

        // ★向きは**その窓が開いている間ずっと同じ**にする。窓の幅はページごとの候補数で
        // 変わるので（9 件のページは入らず右、3 件のページは入って左…）、毎回決め直すと
        // ページを送っただけで左右が入れ替わり、**候補送りのキーの意味まで裏返る**
        // （実機 2026-08-09）。決めるのは最初に出したとき = 1 ページ目の幅で。
        let rl = this.candSideRl;
        if (rl === null) {
            rl = true;
            const right = segRect.right + GAP;
            const roomRight = box.right - right;
            const roomLeft = segRect.left - box.left;
            if (roomLeft < w + GAP && (roomRight >= w || roomRight > roomLeft)) rl = false;
            this.candSideRl = rl;
        }
        let left = rl ? segRect.left - w - GAP : segRect.right + GAP;
        // どちらも狭ければ枠内へクランプ（必ず見せる）
        left = Math.min(Math.max(left, box.left), Math.max(box.left, box.right - w));
        const top = Math.min(Math.max(segRect.top, box.top + 4), Math.max(box.top, box.bottom - h - 4));

        this.candFlowLtr = !rl;
        this.candColsEl?.classList.toggle("is-rl", rl);
        el.style.left = `${left - host.left}px`;
        el.style.top = `${top - host.top}px`;
    }

    // ---- 入力ハンドラ ----------------------------------------------------

    onKeyDown(e) {
        if (this.composing || e.isComposing) return; // システム IME の変換中は触らない

        // hechima が入っていれば**先に**渡す。食べたら（preventDefault 済み）ここで終わり
        const ime = this.hechima();
        if (ime) {
            // 変換中の矢印は 90° 回して論理キーとして渡す。縦組では
            //   物理 ↓↑ = 行に沿う  → 論理 →← （文節移動 / Shift で伸縮）
            //   物理 ←→ = 段が進む  → 論理 ↓↑ （次候補 / 前候補。← が次）
            if (this.imeComposing && e.key.startsWith("Arrow") &&
                !e.ctrlKey && !e.altKey && !e.metaKey) {
                const key = arrowToLogical(e.key, this.candFlowLtr);
                e.preventDefault(); // 変換中の素の矢印は本文に流さない
                if (key) ime.handleKeyDown(logicalTap(e, key));
                return;
            }
            if (ime.handleKeyDown(e)) return;
        }

        // アンドゥ / リドゥ。DOM を自前でいじるので native の履歴は当てにできない
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
            e.preventDefault();
            this.restore(e.shiftKey ? this.redoStack : this.undoStack,
                         e.shiftKey ? this.undoStack : this.redoStack);
            return;
        }

        // 矢印を**見た目の向き**に一致させる。
        // 視覚 ↑↓ = 字送り（character）、視覚 ←→ = 行移動（line。← が次の行）。
        // native に任せないのは、Safari が縦書きで論理方向のまま動かすため
        // （Chrome は視覚方向に写像する）。全ブラウザで揃える。
        if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.startsWith("Arrow")) {
            const sel = window.getSelection();
            if (sel && typeof sel.modify === "function" && sel.rangeCount > 0 &&
                this.editorEl.contains(sel.getRangeAt(0).startContainer)) {
                const alter = e.shiftKey ? "extend" : "move";
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    sel.modify(alter, e.key === "ArrowDown" ? "forward" : "backward", "character");
                    this.goalOffsetY = null; // 字送りは行の深さを更新する
                    // 折り返しを跨いだとき、下へ進めば次の行の先頭・上へ戻れば前の行の末尾に出す
                    this.caretSide = e.key === "ArrowDown" ? "downstream" : "upstream";
                } else {
                    this.moveLine(sel, alter, e.key === "ArrowRight"); // → が前の行（右）
                }
                e.preventDefault();
                this.lastCaretOffset = this.caretOffset();
                this.scheduleCaret(true);
                return;
            }
        }

        // 行頭行末とページ送り。**縦組ではページは横に進む**（次ページ = 左）。
        // 変換中は触らない —— セッションの領分なので割り込むと未確定の位置が壊れる
        if (!this.imeComposing && !e.altKey && !e.metaKey &&
            ["Home", "End", "PageUp", "PageDown"].includes(e.key)) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0 && this.editorEl.contains(sel.getRangeAt(0).startContainer)) {
                e.preventDefault();
                const alter = e.shiftKey ? "extend" : "move";
                if (e.ctrlKey && (e.key === "Home" || e.key === "End")) {
                    // Ctrl+Home / Ctrl+End は文頭 / 文末
                    this.setCaretByOffset(e.key === "Home" ? 0 : this.docText().length);
                } else if (e.key === "Home" || e.key === "End") {
                    this.moveToLineEdge(sel, alter, e.key === "End");
                } else {
                    this.movePage(sel, alter, e.key === "PageUp");
                }
                this.lastCaretOffset = this.caretOffset();
                this.scheduleCaret(true);
                return;
            }
        }

        // BS / Delete は native に任せない。Safari は native 編集のあと、壊れた縦書きの
        // キャレット矩形へ向けて「見せるための」スクロールを行い、表示が飛ぶ
        if (!e.ctrlKey && !e.altKey && !e.metaKey &&
            (e.key === "Backspace" || e.key === "Delete")) {
            e.preventDefault();
            this.ensureSelection();
            // 連続削除は 1 段にまとめる（押しっぱなしで文書のコピーが積み上がるのを防ぐ）
            this.snapshotCoalesced();
            this.deleteAround(e.key === "Backspace");
            this.syncFromDom();
            this.scheduleCaret(true);
        }
    }

    onBeforeInput(e) {
        // 改行は必ず "\n" のテキストとして入れる。<br> や <div> を作らせない
        // （offset 系がテキストノードだけを歩く前提を守るため）
        if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") {
            e.preventDefault();
            this.snapshot();
            this.insertTextAtCaret("\n");
            this.syncFromDom();
            this.scheduleCaret(true);
            return;
        }
        // ドロップは書式ごと入ってくるので塞ぐ（貼り付けは paste で処理）
        if (e.inputType === "insertFromDrop") {
            e.preventDefault();
            return;
        }
        // 素の文字入力も native に任せない（Safari の飛びの原因を 1 つ減らす）。
        // **変換中は横取りしない** —— いまは日本語をシステム IME に頼っているので、
        // 未確定の面倒はブラウザに見てもらう必要がある（hechima を繋いだら不要になる）
        if (e.inputType === "insertText" && typeof e.data === "string" && !e.isComposing) {
            e.preventDefault();
            this.snapshotCoalesced();
            this.insertTextAtCaret(e.data);
            this.syncFromDom();
            this.scheduleCaret(true);
            return;
        }
        // ここまで来たものは native が処理する。**変更前**の状態を積む
        // （input は変更後に飛ぶので、そこで積むと 1 打ぶんずれたアンドゥになる）
        this.snapshotCoalesced();
    }

    onPaste(e) {
        e.preventDefault();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        if (!text) return;
        this.snapshot();
        this.insertTextAtCaret(text);
        this.syncFromDom();
        this.scheduleCaret(true);
    }

    onInput() {
        // native が処理した入力の後始末（スナップショットは beforeinput で積んである）
        this.syncFromDom();
        this.scheduleCaret(true);
    }

    /**
     * 数の表示は**すべて「いま / 全体」の形**に揃える。
     * ★以前は「字数」が改行を除いた数、「現在位置」が改行を含むオフセットで、
     * **単位が違うのに並べていた**（3,393 字の文書で「3,506 字目」になる）。
     */
    /**
     * ステータス行の更新を間引く。**集計は本文全体を数え直す**（段落ごとの行数）ので、
     * 打鍵のたびに走らせると 6 万字では効いてくる。キャッシュは本文をキーにしていて
     * **打鍵のたびに外れる**ため、頻度そのものを落とすのが正しい。
     * 数の表示は 0.2 秒遅れても困らない。
     */
    scheduleStatus() {
        if (this.statusTimer) return;
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            this.updateStatus();
        }, 200);
    }

    updateStatus() {
        if (!this.countEl) return;
        const text = this.data ?? "";
        const off = document.activeElement === this.editorEl
            ? this.caretOffset()
            : Math.min(this.lastCaretOffset, text.length);
        const head = text.slice(0, off);
        // ★行数は**いま画面で 1 行に入る字数**で数える（設定値、自動なら実測）。
        // 20 字固定だと、行長を変えたとき見えている行数と食い違う。
        // 枚数だけは 400 字詰め換算（20 字 × 20 行）という別の単位で、混ぜない
        const perLine = this.charsPerLine();
        const chars = countChars(text);
        const lines = countLines(text, perLine);
        const sheets = chars
            ? (countLines(text, GENKO_CHARS_PER_LINE) / GENKO_LINES_PER_SHEET).toFixed(1)
            : "0.0";
        this.countEl.empty();
        for (const t of [
            `${countChars(head).toLocaleString()} / ${chars.toLocaleString()} 字`,
            `${currentLine(text, off, perLine, this.caretSide === "downstream").toLocaleString()}` +
                ` / ${lines.toLocaleString()} 行`,
            `${sheets} 枚`,
        ]) {
            this.countEl.createSpan({ text: t });
        }
        if (this.lineLengthShort) {
            const want = Number(this.plugin?.settings?.lineLength) || 0;
            const warn = this.countEl.createSpan({
                cls: "is-warn",
                text: `行長 ${this.lineLengthShort} / ${want} 字`,
            });
            warn.title = "画面の高さが足りず、指定した行長で折り返せていません";
        }
        if (this.modeEl) this.modeEl.setText(this.imeLabel());
    }

    /** IME の状態。**モバイルには Obsidian のステータスバーが無い**ので、ここが唯一の置き場 */
    imeLabel() {
        const ime = this.hechima();
        if (!ime) return "";
        try {
            return ime.active ? `あ ${ime.keymapName()}` : "A 直接入力";
        } catch {
            return "";
        }
    }
}

class TategakiSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        this.containerEl.empty();
        new Setting(this.containerEl)
            .setName("行長（1 行の字数）")
            .setDesc(
                "0 でペインの高さいっぱい。20 なら 20 字で折り返す（400 字詰め原稿用紙の 1 行）。" +
                "全角 1 字を 1em として数えるので、等幅でない書体では多少ずれる。"
            )
            .addText((t) =>
                t
                    .setPlaceholder("0")
                    .setValue(String(this.plugin.settings.lineLength ?? 0))
                    .onChange(async (v) => {
                        const n = Math.max(0, Math.min(200, Number(v) || 0));
                        this.plugin.settings.lineLength = n;
                        await this.plugin.saveSettings();
                    })
            );
    }
}

module.exports = class TategakiPlugin extends Plugin {
    async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.registerView(VIEW_TYPE, (leaf) => new TategakiView(leaf, this));
        this.addSettingTab(new TategakiSettingTab(this.app, this));

        this.addCommand({
            id: "toggle-tategaki",
            name: "縦書きで開く / 横書きに戻す",
            callback: () => this.toggle(),
        });

        this.addRibbonIcon("pilcrow", "縦書きで開く / 横書きに戻す", () => this.toggle());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        // 開いている縦書きビューへ即座に反映する（開き直させない）
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            leaf.view?.applyLineLength?.();
        }
    }

    /**
     * いま開いているノートのビューを縦書き ⇄ Markdown で入れ替える。
     * **同じファイルを別のビューで開き直す**方式（Kanban や Excalidraw と同じ）なので、
     * ファイルの実体は Markdown のまま。プレビューを増やすわけではない。
     */
    async toggle() {
        // ★**ファイルはワークスペースに訊く。** リーフの view から取ると、
        // 復元に失敗した空のタブ（種別を改名した後などに残る）を掴んだときに
        // パスが空のまま切り替えようとして「ファイル "" を開くのに失敗しました」になる
        const file = this.app.workspace.getActiveFile();
        if (!file?.path) {
            new Notice("縦書き: ファイルが開かれていない");
            return;
        }
        const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf(false);
        const toMarkdown = leaf?.getViewState?.()?.type === VIEW_TYPE;
        const state = toMarkdown
            ? { type: "markdown", active: true, state: { file: file.path, mode: "source" } }
            : { type: VIEW_TYPE, active: true, state: { file: file.path } };
        try {
            await leaf.setViewState(state);
        } catch (e) {
            // そのタブが壊れているときは、新しいタブで開き直す
            try {
                await this.app.workspace.getLeaf(true).setViewState(state);
            } catch {
                new Notice(`縦書き: 切り替えられません — ${String(e?.message ?? e)}`);
            }
        }
    }
};
