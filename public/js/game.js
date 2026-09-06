/* Factory World — Phaser 게임 계층 (아이소메트릭 맵 · 픽셀 캐릭터 · 설비) */
(function () {
  const TW = 64, TH = 32;           // 타일 크기(스크린)
  const HW = TW / 2, HH = TH / 2;   // 절반
  const MAP_W = 24, MAP_H = 16;
  const SPEED = 4.2;                // 타일/초
  const STATUS_COLOR = { RUN: 0x34d399, IDLE: 0xfbbf24, STOP: 0xf87171, ALARM: 0xef4444 };

  const FW = (window.FW = window.FW || {});

  function isoX(x, y) { return (x - y) * HW; }
  function isoY(x, y) { return (x + y) * HH; }
  function screenToWorld(sx, sy) {
    return { x: (sx / HW + sy / HH) / 2, y: (sy / HH - sx / HW) / 2 };
  }

  // ── 픽셀 캐릭터 스프라이트 절차 생성 ──────────────────
  // 프레임 16x22, 3열(idle/stepA/stepB) x 3행(down/side/up). right는 side의 flipX.
  const FRAME_W = 16, FRAME_H = 22;
  const PAL = { skin: '#f2c89a', hair: '#453226', pants: '#31384f', shoe: '#20242f', eye: '#20242f' };

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + [f(n >> 16 & 255), f(n >> 8 & 255), f(n & 255)].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  function drawCharFrame(ctx, ox, oy, row, f, shirt) {
    const px = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(ox + x, oy + y, w, h); };
    const shirtDark = shade(shirt, -35);

    if (row === 0 || row === 2) { // down / up
      px(4, 0, 8, 3, PAL.hair);                       // 머리카락
      px(4, 3, 8, 5, PAL.skin);                       // 얼굴
      if (row === 2) px(4, 3, 8, 3, PAL.hair);        // 뒷모습은 뒤통수
      if (row === 0) { px(6, 5, 1, 1, PAL.eye); px(9, 5, 1, 1, PAL.eye); } // 눈
      px(4, 8, 8, 6, shirt);                          // 몸통
      px(4, 8, 8, 1, shirtDark);                      // 어깨 라인
      // 팔 (걷기 스윙)
      const armL = f === 1 ? 7 : f === 2 ? 9 : 8;
      const armR = f === 2 ? 7 : f === 1 ? 9 : 8;
      px(3, armL, 1, 5, shirt); px(3, armL + 5, 1, 1, PAL.skin);
      px(12, armR, 1, 5, shirt); px(12, armR + 5, 1, 1, PAL.skin);
      px(4, 14, 8, 3, PAL.pants);                     // 허리~허벅지
      // 다리 (좌우 교차)
      const legLUp = f === 1 ? 2 : 0, legRUp = f === 2 ? 2 : 0;
      px(4, 17, 3, 3 - legLUp, PAL.pants); px(4, 20 - legLUp, 3, 2, PAL.shoe);
      px(9, 17, 3, 3 - legRUp, PAL.pants); px(9, 20 - legRUp, 3, 2, PAL.shoe);
    } else { // side (왼쪽 바라봄)
      px(5, 0, 7, 3, PAL.hair);
      px(4, 1, 1, 3, PAL.hair);                       // 앞머리
      px(5, 3, 7, 5, PAL.skin);
      px(6, 5, 1, 1, PAL.eye);
      px(5, 8, 7, 6, shirt);
      px(5, 8, 7, 1, shirtDark);
      const arm = f === 1 ? 6 : f === 2 ? 8 : 7;      // 팔 스윙(앞뒤)
      px(arm, 9, 2, 5, shirtDark); px(arm, 14, 2, 1, PAL.skin);
      px(5, 14, 7, 3, PAL.pants);
      // 다리: 앞/뒤 교차
      const front = f === 1 ? 5 : f === 2 ? 8 : 6;
      const back = f === 1 ? 9 : f === 2 ? 6 : 9;
      px(front, 17, 2, 3, PAL.pants); px(front - 1, 20, 3, 2, PAL.shoe);
      px(back, 17, 2, 3, PAL.pants); px(back, 20, 2, 2, PAL.shoe);
    }
  }

  function ensureCharAssets(scene, colorHex) {
    const key = 'char-' + colorHex.replace('#', '');
    if (!scene.textures.exists(key)) {
      const canvas = document.createElement('canvas');
      canvas.width = FRAME_W * 3; canvas.height = FRAME_H * 3;
      const ctx = canvas.getContext('2d');
      for (let row = 0; row < 3; row++)
        for (let f = 0; f < 3; f++)
          drawCharFrame(ctx, f * FRAME_W, row * FRAME_H, row, f, colorHex);
      const tex = scene.textures.addCanvas(key, canvas);
      let i = 0;
      for (let row = 0; row < 3; row++)
        for (let f = 0; f < 3; f++)
          tex.add(i++, 0, f * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
    }
    // 걷기 애니메이션 (down=0행, side=1행, up=2행)
    [['down', 0], ['side', 3], ['up', 6]].forEach(([dir, base]) => {
      const animKey = `${key}-walk-${dir}`;
      if (!scene.anims.exists(animKey)) {
        scene.anims.create({
          key: animKey,
          frames: [{ key, frame: base + 1 }, { key, frame: base }, { key, frame: base + 2 }, { key, frame: base }],
          frameRate: 8, repeat: -1,
        });
      }
    });
    return key;
  }

  // 테마 색 읽기 (style.css의 --map-* 변수) — 다크/라이트 전환은 페이지 재로드로 적용
  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    const v = (n, def) => (css.getPropertyValue(n) || '').trim() || def;
    const hex = (s) => Phaser.Display.Color.HexStringToColor(s).color;
    return {
      bg: v('--map-bg', '#0d0f17'),
      tileA: hex(v('--map-tile-a', '#171a24')), tileB: hex(v('--map-tile-b', '#191d29')),
      line: hex(v('--map-line', '#0d0f17')),
      label: v('--map-label', '#aab3cc'), text: v('--map-text', '#e6e9f2'), stroke: v('--map-stroke', '#0d0f17'),
      zoneMix: Math.max(0, Math.min(1, parseFloat(v('--map-zone-mix', '0')) || 0)),
    };
  }
  function mixWithWhite(hexStr, t) {
    const c = Phaser.Display.Color.HexStringToColor(hexStr);
    if (!t) return c.color;
    const m = Phaser.Display.Color.Interpolate.ColorWithColor(c, new Phaser.Display.Color(255, 255, 255), 100, Math.round(t * 100));
    return Phaser.Display.Color.GetColor(m.r, m.g, m.b);
  }

  const IDLE_FRAME = { down: 0, side: 3, up: 6 };
  function dirRow(dir) { return dir === 'left' || dir === 'right' ? 'side' : dir; }

  class FactoryScene extends Phaser.Scene {
    constructor() { super('factory'); }

    create() {
      const init = FW.initData;
      this.theme = readTheme();
      this.zonesData = init.zones;
      this.eqSprites = new Map();
      this.playerSprites = new Map();
      this.chatRadius = init.chatRadius;
      this.moveTarget = null;
      this.lastSent = 0;
      this.nearEqId = null;

      this.drawFloor();
      this.floorplan = init.floorplan || null;
      this.drawFloorplan();
      init.equipments.forEach(eq => this.addEquipment(eq));

      // 공정 라인 (설비 간 연결 — 부하 시각화)
      this.links = init.links || [];
      this.linkStates = new Map((init.linkStates || []).map(s => [s.id, s]));
      this.linkGfx = this.add.graphics().setDepth(-800);
      this.linkLabels = new Map();  // linkId -> text
      this.linkDots = new Map();    // linkId -> [circle, circle]
      this.drawLinks();

      const me = init.me;
      this.me = this.makeCharacter(me.name, me.badge, me.color, me.x, me.y, true, me.level);
      init.players.forEach(p => this.addPlayer(p));

      const cam = this.cameras.main;
      cam.setBackgroundColor(this.theme.bg);
      cam.startFollow(this.me, true, 0.12, 0.12);
      cam.setZoom(Math.min(1.15, Math.max(0.8, this.scale.width / 1400 + 0.35)) * (FW.lowFx ? 0.9 : 1));

      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasd = this.input.keyboard.addKeys('W,A,S,D');
      this.input.on('pointerdown', (pointer) => {
        if (pointer.event.target.tagName !== 'CANVAS') return;
        const wp = cam.getWorldPoint(pointer.x, pointer.y);
        const t = screenToWorld(wp.x, wp.y);
        if (t.x < 0 || t.y < 0 || t.x > MAP_W || t.y > MAP_H) return;
        this.moveTarget = t;
      });
      this.input.keyboard.disableGlobalCapture();
    }

    drawFloor() {
      // 이전 바닥/존 라벨 제거 (맵 에디터 변경 시 재생성)
      (this.floorObjs || []).forEach(o => o.destroy());
      this.floorObjs = [];
      const g = this.add.graphics().setDepth(-1000);
      this.floorObjs.push(g);
      const lowFx = !!FW.lowFx; // 저사양: 타일 테두리 생략
      const T = this.theme;
      const zoneBase = new Map(); // zoneId -> 테마 반영 색 (라이트: 흰색과 섞어 연하게)
      for (const z of this.zonesData) zoneBase.set(z.id, mixWithWhite(z.color, T.zoneMix));
      for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
          const zone = this.zonesData.find(z =>
            x >= z.rect_x && x < z.rect_x + z.rect_w && y >= z.rect_y && y < z.rect_y + z.rect_h);
          let color = (x + y) % 2 === 0 ? T.tileA : T.tileB;
          if (zone) {
            const base = zoneBase.get(zone.id);
            color = (x + y) % 2 === 0 ? base : Phaser.Display.Color.IntegerToColor(base).darken(T.zoneMix > 0 ? 4 : 8).color;
          }
          const cx = isoX(x + 0.5, y + 0.5), cy = isoY(x + 0.5, y + 0.5);
          g.fillStyle(color, 0.9);
          g.beginPath();
          g.moveTo(cx, cy - HH); g.lineTo(cx + HW, cy); g.lineTo(cx, cy + HH); g.lineTo(cx - HW, cy);
          g.closePath(); g.fillPath();
          if (!lowFx) { g.lineStyle(1, T.line, 0.35); g.strokePath(); }
        }
      }
      this.zonesData.forEach(z => {
        const cx = isoX(z.rect_x + z.rect_w / 2, z.rect_y + 0.2);
        const cy = isoY(z.rect_x + z.rect_w / 2, z.rect_y + 0.2) - 14;
        this.floorObjs.push(this.add.text(cx, cy, z.name, {
          fontSize: '13px', fontStyle: 'bold', color: T.label,
          stroke: T.stroke, strokeThickness: 3,
        }).setOrigin(0.5).setDepth(-900));
      });
    }

    // ── 공장 평면도 배경 (옵션): 상단 뷰 도면 이미지를 아이소메트릭으로 투영해 바닥 위에 깔기 ──
    setFloorplan(plan) {
      this.floorplan = plan || null;
      this.drawFloorplan();
    }

    drawFloorplan() {
      if (this.planImage) { this.planImage.destroy(); this.planImage = null; }
      if (this.textures.exists('floorplan-iso')) this.textures.remove('floorplan-iso');
      const plan = this.floorplan;
      if (!plan || !plan.file || !plan.showInGame) return;
      const key = 'floorplan-src-' + plan.file;
      const build = () => {
        if (!this.textures.exists(key) || this.floorplan !== plan) return;
        const src = this.textures.get(key).getSourceImage();
        const r = plan.rect || { x: 0, y: 0, w: MAP_W, h: MAP_H };
        // 타일 사각형 (r.x, r.y)~(r.x+r.w, r.y+r.h)의 아이소메트릭 경계
        const minX = isoX(r.x, r.y + r.h), minY = isoY(r.x, r.y);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil((r.w + r.h) * HW); canvas.height = Math.ceil((r.w + r.h) * HH);
        const ctx = canvas.getContext('2d');
        // 이미지 픽셀 (u,v) → 타일 (r.x + u·sx, r.y + v·sy) → iso 변환을 하나의 아핀 행렬로
        const sx = r.w / src.width, sy = r.h / src.height;
        ctx.setTransform(HW * sx, HH * sx, -HW * sy, HH * sy, (r.x - r.y) * HW - minX, (r.x + r.y) * HH - minY);
        ctx.drawImage(src, 0, 0);
        this.textures.addCanvas('floorplan-iso', canvas);
        this.planImage = this.add.image(minX, minY, 'floorplan-iso')
          .setOrigin(0, 0).setDepth(-995).setAlpha(plan.opacity ?? 0.6);
      };
      if (this.textures.exists(key)) return build();
      const url = `/api/floorplan/image?f=${encodeURIComponent(plan.file)}&token=${encodeURIComponent(FW.token || '')}`;
      this.load.image(key, url);
      this.load.once(Phaser.Loader.Events.COMPLETE, build);
      this.load.start();
    }

    removeEquipment(eqId) {
      const c = this.eqSprites.get(eqId);
      if (!c) return;
      c.alarmTween.remove();
      c.destroy();
      this.eqSprites.delete(eqId);
    }

    // 존/설비 마스터 변경을 새로고침 없이 반영 (NFR-02: 맵은 데이터)
    reloadWorld(zones, equipments) {
      this.zonesData = zones;
      this.drawFloor();
      const keep = new Set();
      for (const eq of equipments) {
        keep.add(eq.id);
        const cur = this.eqSprites.get(eq.id);
        const same = cur && cur.eqData.x === eq.x && cur.eqData.y === eq.y && cur.eqData.name === eq.name;
        if (same) { cur.eqData = eq; this.setEquipmentStatus(eq.id, eq.status); continue; }
        this.removeEquipment(eq.id);
        this.addEquipment(eq);
      }
      for (const id of [...this.eqSprites.keys()]) if (!keep.has(id)) this.removeEquipment(id);
      this.drawLinks();
    }

    // 재접속 시 서버가 보낸 접속자 목록으로 원격 캐릭터를 다시 맞춤
    resetPlayers(players) {
      for (const id of [...this.playerSprites.keys()]) this.removePlayer(id);
      players.forEach(p => this.addPlayer(p));
    }

    addEquipment(eq) {
      const c = this.add.container(isoX(eq.x + 0.5, eq.y + 0.5), isoY(eq.x + 0.5, eq.y + 0.5));
      c.setDepth(eq.x + eq.y);

      const body = this.add.graphics();
      this.drawMachine(body);
      const lamp = this.add.circle(0, -40, 5, STATUS_COLOR[eq.status] || 0x888888);
      const glow = this.add.circle(0, -40, 9, STATUS_COLOR[eq.status] || 0x888888, 0.25);
      const label = this.add.text(0, -58, eq.name, {
        fontSize: '12px', fontStyle: 'bold', color: this.theme.text, stroke: this.theme.stroke, strokeThickness: 3,
      }).setOrigin(0.5);
      const ring = this.add.graphics();
      ring.lineStyle(2, 0x4fc3f7, 0.8);
      ring.strokeEllipse(0, HH * 0.5, TW * 1.15, TH * 1.15);
      ring.setVisible(false);

      c.add([ring, body, lamp, glow, label]);
      c.eqData = eq; c.lamp = lamp; c.glow = glow; c.ring = ring;

      // 알람 점멸 — 저사양 모드에서는 점멸 대신 큰 정적 광원으로 표시
      c.alarmTween = this.tweens.add({
        targets: [lamp, glow], alpha: { from: 1, to: 0.15 }, duration: 420, yoyo: true, repeat: -1,
        paused: eq.status !== 'ALARM' || !!FW.lowFx,
      });
      if (eq.status !== 'ALARM' || FW.lowFx) { lamp.alpha = 1; glow.alpha = eq.status === 'ALARM' ? 0.6 : 0.25; }

      const hit = this.add.zone(0, -18, TW * 1.1, 56).setOrigin(0.5).setInteractive({ useHandCursor: true });
      hit.on('pointerdown', (pointer, lx, ly, event) => {
        event.stopPropagation();
        FW.onOpenEquipment && FW.onOpenEquipment(eq.id);
      });
      c.add(hit);

      this.eqSprites.set(eq.id, c);
    }

    drawMachine(g) {
      const w = HW * 0.9, h = HH * 0.9, z = 26;
      g.fillStyle(0x39415c, 1);
      g.beginPath(); g.moveTo(-w, 0); g.lineTo(0, h); g.lineTo(0, h - z); g.lineTo(-w, -z); g.closePath(); g.fillPath();
      g.fillStyle(0x2c3348, 1);
      g.beginPath(); g.moveTo(w, 0); g.lineTo(0, h); g.lineTo(0, h - z); g.lineTo(w, -z); g.closePath(); g.fillPath();
      g.fillStyle(0x4a5578, 1);
      g.beginPath(); g.moveTo(0, -h - z); g.lineTo(w, -z); g.lineTo(0, h - z); g.lineTo(-w, -z); g.closePath(); g.fillPath();
      g.lineStyle(1, 0x1a1e2c, 0.9);
      g.strokePath();
    }

    // ── 공정 라인 (부하 색상 + 자재 흐름 점) ──
    linkColor(level) {
      if (level < 40) return 0x34d399;
      if (level < 70) return 0xfbbf24;
      if (level < 90) return 0xfb923c;
      return 0xef4444;
    }

    linkEnds(link) {
      const a = this.eqSprites.get(link.fromId), b = this.eqSprites.get(link.toId);
      if (!a || !b) return null;
      return { ax: a.x, ay: a.y + 8, bx: b.x, by: b.y + 8 };
    }

    drawLinks() {
      const g = this.linkGfx;
      g.clear();
      const alive = new Set();
      for (const link of this.links) {
        const e = this.linkEnds(link);
        if (!e) continue;
        alive.add(link.id);
        const s = this.linkStates.get(link.id) || { level: 0, flowing: false };
        const color = this.linkColor(s.level);
        // 라인 본체 (테두리 + 부하 색)
        g.lineStyle(9, this.theme.line, 0.55);
        g.lineBetween(e.ax, e.ay, e.bx, e.by);
        g.lineStyle(5, color, 0.9);
        g.lineBetween(e.ax, e.ay, e.bx, e.by);
        // 방향 화살표 (중점)
        const mx = (e.ax + e.bx) / 2, my = (e.ay + e.by) / 2;
        const ang = Math.atan2(e.by - e.ay, e.bx - e.ax);
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(mx + Math.cos(ang) * 9, my + Math.sin(ang) * 9);
        g.lineTo(mx + Math.cos(ang + 2.5) * 8, my + Math.sin(ang + 2.5) * 8);
        g.lineTo(mx + Math.cos(ang - 2.5) * 8, my + Math.sin(ang - 2.5) * 8);
        g.closePath(); g.fillPath();
        // 부하 라벨
        let label = this.linkLabels.get(link.id);
        if (!label) {
          label = this.add.text(0, 0, '', {
            fontSize: '10px', fontStyle: 'bold', stroke: this.theme.stroke, strokeThickness: 3,
          }).setOrigin(0.5).setDepth(-790);
          this.linkLabels.set(link.id, label);
        }
        label.setPosition(mx, my - 14);
        label.setText(s.level > 3 ? `${s.level}%` : '');
        label.setColor(s.level >= 90 ? '#ef4444' : s.level >= 70 ? '#fb923c' : s.level >= 40 ? '#fbbf24' : '#8be3c0');
        // 자재 흐름 점 (상류 가동 중일 때만)
        let dots = this.linkDots.get(link.id);
        if (!dots) {
          dots = [0, 1].map(() => this.add.circle(0, 0, 3.5, 0xcfd6e8).setDepth(-780).setVisible(false));
          this.linkDots.set(link.id, dots);
        }
        dots.forEach(d => { d.__ends = e; d.setVisible(!!s.flowing && !FW.lowFx); });
      }
      // 삭제된 라인 정리
      for (const [id, label] of this.linkLabels) if (!alive.has(id)) { label.destroy(); this.linkLabels.delete(id); }
      for (const [id, dots] of this.linkDots) if (!alive.has(id)) { dots.forEach(d => d.destroy()); this.linkDots.delete(id); }
    }

    setLinks(links, states) {
      this.links = links || [];
      if (states) this.linkStates = new Map(states.map(s => [s.id, s]));
      this.drawLinks();
    }

    updateLinkStates(states) {
      for (const s of states) this.linkStates.set(s.id, s);
      this.drawLinks();
    }

    animateLinkDots(time) {
      for (const [id, dots] of this.linkDots) {
        dots.forEach((d, i) => {
          if (!d.visible || !d.__ends) return;
          const t = ((time / 1800) + i / dots.length) % 1;
          d.x = d.__ends.ax + (d.__ends.bx - d.__ends.ax) * t;
          d.y = d.__ends.ay + (d.__ends.by - d.__ends.ay) * t;
        });
      }
    }

    setEquipmentStatus(eqId, status) {
      const c = this.eqSprites.get(eqId);
      if (!c) return;
      c.eqData.status = status;
      const col = STATUS_COLOR[status] || 0x888888;
      c.lamp.fillColor = col; c.glow.fillColor = col;
      if (status === 'ALARM' && !FW.lowFx) c.alarmTween.resume();
      else { c.alarmTween.pause(); c.lamp.alpha = 1; c.glow.alpha = status === 'ALARM' ? 0.6 : 0.25; }
    }

    makeCharacter(name, badge, colorHex, x, y, isMe, level) {
      const texKey = ensureCharAssets(this, colorHex || '#4fc3f7');
      const c = this.add.container(isoX(x, y), isoY(x, y));
      const shadow = this.add.ellipse(0, 6, 26, 12, 0x000000, 0.35);
      const sprite = this.add.sprite(0, 9, texKey, 0).setOrigin(0.5, 1).setScale(2);
      sprite.texture.setFilter(Phaser.Textures.FilterMode.NEAREST); // 픽셀 아트 선명하게
      const T = this.theme;
      const label = this.add.text(0, -55, level ? `Lv.${level} ${name}` : `${name}`, {
        fontSize: '11px', fontStyle: 'bold', color: isMe ? (T.zoneMix > 0 ? '#0b3d5c' : '#ffffff') : T.text,
        stroke: T.stroke, strokeThickness: 3,
      }).setOrigin(0.5);
      const badgeT = this.add.text(0, -44, badge || '', {
        fontSize: '9px', color: T.label, stroke: T.stroke, strokeThickness: 2,
      }).setOrigin(0.5);
      c.add([shadow, sprite, badgeT, label]);
      c.wx = x; c.wy = y; c.sprite = sprite; c.texKey = texKey;
      c.moving = false; c.dir = 'down';
      c.targetX = x; c.targetY = y;
      return c;
    }

    animateChar(c) {
      const row = dirRow(c.dir);
      c.sprite.setFlipX(c.dir === 'right');
      if (c.moving) c.sprite.play(`${c.texKey}-walk-${row}`, true);
      else { c.sprite.stop(); c.sprite.setFrame(IDLE_FRAME[row]); }
    }

    addPlayer(p) {
      if (this.playerSprites.has(p.socketId)) return;
      const c = this.makeCharacter(p.name, p.badge, p.color, p.x, p.y, false, p.level);
      c.dir = p.dir || 'down';
      this.playerSprites.set(p.socketId, c);
    }
    removePlayer(socketId) {
      const c = this.playerSprites.get(socketId);
      if (c) { c.destroy(); this.playerSprites.delete(socketId); }
    }
    movePlayer(socketId, x, y, moving, dir) {
      const c = this.playerSprites.get(socketId);
      if (c) { c.targetX = x; c.targetY = y; c.moving = moving; if (dir) c.dir = dir; }
    }

    update(time, delta) {
      const dt = delta / 1000;
      this.updateMe(dt);
      for (const c of this.playerSprites.values()) {
        c.wx += (c.targetX - c.wx) * Math.min(1, dt * 10);
        c.wy += (c.targetY - c.wy) * Math.min(1, dt * 10);
        this.placeChar(c);
      }
      this.animateLinkDots(time);
    }

    updateMe(dt) {
      if (FW.typing) { this.emitMoveIfNeeded(false); this.placeChar(this.me); return; }
      let sx = 0, sy = 0;
      const td = FW.touchDir || {};
      if (this.cursors.left.isDown || this.wasd.A.isDown || td.left) sx -= 1;
      if (this.cursors.right.isDown || this.wasd.D.isDown || td.right) sx += 1;
      if (this.cursors.up.isDown || this.wasd.W.isDown || td.up) sy -= 1;
      if (this.cursors.down.isDown || this.wasd.S.isDown || td.down) sy += 1;

      let dx = 0, dy = 0;
      if (sx || sy) {
        this.moveTarget = null;
        dx = (sx / 2 + sy); dy = (sy - sx / 2);
        const len = Math.hypot(dx, dy) || 1;
        dx = dx / len * SPEED * dt; dy = dy / len * SPEED * dt;
      } else if (this.moveTarget) {
        const tx = this.moveTarget.x - this.me.wx, ty = this.moveTarget.y - this.me.wy;
        const dist = Math.hypot(tx, ty);
        if (dist < 0.08) this.moveTarget = null;
        else {
          const step = Math.min(dist, SPEED * dt);
          dx = tx / dist * step; dy = ty / dist * step;
        }
      }

      const moving = !!(dx || dy);
      if (moving) {
        this.me.wx = Phaser.Math.Clamp(this.me.wx + dx, 0.4, MAP_W - 0.4);
        this.me.wy = Phaser.Math.Clamp(this.me.wy + dy, 0.4, MAP_H - 0.4);
        // 스크린 기준 방향 판정 (아이소메트릭 투영)
        const dsx = (dx - dy) * 2, dsy = (dx + dy);
        this.me.dir = Math.abs(dsx) > Math.abs(dsy)
          ? (dsx > 0 ? 'right' : 'left')
          : (dsy > 0 ? 'down' : 'up');
      }
      this.me.moving = moving;
      this.placeChar(this.me);
      this.emitMoveIfNeeded(moving);
      this.updateNearHighlight();
    }

    emitMoveIfNeeded(moving) {
      const now = performance.now();
      if (now - this.lastSent < 100) return;
      if (!moving && this.wasMoving === false) return;
      this.lastSent = now;
      this.wasMoving = moving;
      FW.sendMove && FW.sendMove(this.me.wx, this.me.wy, moving, this.me.dir);
    }

    placeChar(c) {
      c.x = isoX(c.wx, c.wy);
      c.y = isoY(c.wx, c.wy);
      c.setDepth(c.wx + c.wy + 0.5);
      this.animateChar(c);
    }

    updateNearHighlight() {
      let nearest = null, nd = Infinity;
      for (const c of this.eqSprites.values()) {
        const dx = this.me.wx - (c.eqData.x + 0.5), dy = this.me.wy - (c.eqData.y + 0.5);
        const d = Math.hypot(dx, dy);
        c.ring.setVisible(d <= this.chatRadius);
        if (d <= this.chatRadius && d < nd) { nd = d; nearest = c.eqData.id; }
      }
      this.nearEqId = nearest;
    }
  }

  FW.startGame = function (initData) {
    FW.initData = initData;
    // 저사양 모드(NFR-05): 30fps 제한 + 안티앨리어싱 해제 + 해상도 스케일 축소
    FW.phaserGame = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-container',
      width: window.innerWidth,
      height: window.innerHeight,
      pixelArt: true,
      scene: FactoryScene,
      scale: { mode: Phaser.Scale.RESIZE },
      fps: FW.lowFx ? { target: 30, forceSetTimeOut: false } : undefined,
      render: FW.lowFx ? { antialias: false, powerPreference: 'low-power' } : undefined,
    });
    FW.scene = () => FW.phaserGame.scene.getScene('factory');
  };

  FW.gameApi = {
    addPlayer: (p) => FW.scene()?.addPlayer(p),
    removePlayer: (id) => FW.scene()?.removePlayer(id),
    movePlayer: (id, x, y, m, dir) => FW.scene()?.movePlayer(id, x, y, m, dir),
    setEquipmentStatus: (eqId, s) => FW.scene()?.setEquipmentStatus(eqId, s),
    setLinks: (links, states) => FW.scene()?.setLinks(links, states),
    updateLinkStates: (states) => FW.scene()?.updateLinkStates(states),
    reloadWorld: (zones, equipments) => FW.scene()?.reloadWorld(zones, equipments),
    setFloorplan: (plan) => FW.scene()?.setFloorplan(plan),
    resetPlayers: (players) => FW.scene()?.resetPlayers(players),
    myPosition: () => { const s = FW.scene(); return s?.me ? { x: s.me.wx, y: s.me.wy, dir: s.me.dir } : null; },
  };
})();
