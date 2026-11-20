// Egg drawing editor - canvas overlay. Usage:
//   EggDrawer.open({ onSave: ({drawing_id, thumb}) => {...} })
// onSave receives drawing_id = stored filename, thumb = small dataURL preview.
const EggDrawer = (() => {
  const SIZE = 480;

  function eggPath(ctx) {
    // Slightly tapered egg shape centered in canvas
    const cx = SIZE / 2, cy = SIZE / 2 + 6, rx = 128, ry = 160;
    ctx.beginPath();
    ctx.moveTo(cx, cy - ry);
    ctx.bezierCurveTo(cx + rx * 1.05, cy - ry * 0.75, cx + rx, cy + ry * 0.25, cx + rx * 0.82, cy + ry * 0.8);
    ctx.bezierCurveTo(cx + rx * 0.6, cy + ry * 1.12, cx - rx * 0.6, cy + ry * 1.12, cx - rx * 0.82, cy + ry * 0.8);
    ctx.bezierCurveTo(cx - rx, cy + ry * 0.25, cx - rx * 1.05, cy - ry * 0.75, cx, cy - ry);
    ctx.closePath();
  }

  function paintBase(ctx) {
    eggPath(ctx);
    const g = ctx.createRadialGradient(SIZE/2 - 40, SIZE/2 - 60, 40, SIZE/2, SIZE/2, SIZE*0.75);
    g.addColorStop(0, '#fdf6e3');
    g.addColorStop(1, '#efe0bf');
    ctx.fillStyle = g;
    ctx.fill();
  }

  function open({ onSave }) {
    // Build overlay DOM once
    let overlay = document.getElementById('egg-drawer-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'egg-drawer-overlay';
      overlay.className = 'overlay';
      overlay.innerHTML = `
        <div class="drawer">
          <h2>Draw on your egg</h2>
          <div class="canvas-wrap"><canvas id="egg-canvas" width="${SIZE}" height="${SIZE}"></canvas></div>
          <div class="tools" id="egg-tools">
            <input type="range" id="egg-size" min="2" max="40" value="10" title="Brush size">
            <button class="eraser-btn" id="egg-eraser" type="button">Eraser</button>
            <button class="eraser-btn" id="egg-undo" type="button">Undo</button>
            <button class="eraser-btn" id="egg-clear" type="button">Clear</button>
          </div>
          <div class="tools" id="egg-palette"></div>
          <div class="actions" style="margin-top:14px">
            <button class="btn" id="egg-save" type="button">Save drawing</button>
            <button class="btn ghost" id="egg-cancel" type="button">Cancel</button>
          </div>
          <div id="egg-msg"></div>
        </div>`;
      document.body.appendChild(overlay);
    }
    overlay.classList.add('open');

    const canvas = overlay.querySelector('#egg-canvas');
    const ctx = canvas.getContext('2d');
    const base = document.createElement('canvas');
    base.width = base.height = SIZE;
    paintBase(base.getContext('2d'));

    let color = '#1a1a1a';
    let erasing = false;
    let drawing = false;
    let last = null;

    const layer = document.createElement('canvas');
    layer.width = layer.height = SIZE;
    const lctx = layer.getContext('2d');
    const strokeUndo = [];

    function syncLayer() {
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.drawImage(base, 0, 0);
      ctx.drawImage(layer, 0, 0);
    }

    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * SIZE / r.width,
        y: (e.clientY - r.top) * SIZE / r.height,
      };
    }
    function strokePath(from, to) {
      lctx.save();
      eggPath(lctx);
      lctx.clip();
      lctx.lineCap = 'round'; lctx.lineJoin = 'round';
      lctx.strokeStyle = erasing ? 'rgba(0,0,0,1)' : color;
      lctx.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
      lctx.lineWidth = Number(overlay.querySelector('#egg-size').value);
      lctx.beginPath();
      lctx.moveTo(from.x, from.y);
      lctx.lineTo(to.x, to.y);
      lctx.stroke();
      lctx.restore();
      syncLayer();
    }

    canvas.addEventListener('pointerdown', e => {
      e.preventDefault();
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      strokeUndo.push(lctx.getImageData(0, 0, SIZE, SIZE));
      if (strokeUndo.length > 25) strokeUndo.shift();
      last = pos(e);
      strokePath(last, last);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing) return;
      const p = pos(e);
      strokePath(last, p);
      last = p;
    });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // Palette
    const paletteEl = overlay.querySelector('#egg-palette');
    WSHOP.api('/api/public/settings').then(s => {
      paletteEl.innerHTML = s.palette.map((c, i) =>
        `<button class="swatch${i === 0 ? ' sel' : ''}" data-c="${c}" style="background:${c}" type="button" title="${c}"></button>`).join('');
      paletteEl.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
        color = b.dataset.c;
        erasing = false;
        overlay.querySelector('#egg-eraser').classList.remove('sel');
        paletteEl.querySelectorAll('.swatch').forEach(x => x.classList.toggle('sel', x === b));
      }));
    }).catch(() => {});

    overlay.querySelector('#egg-eraser').addEventListener('click', e => {
      erasing = !erasing;
      e.currentTarget.classList.toggle('sel', erasing);
      paletteEl.querySelectorAll('.swatch').forEach(x => x.classList.remove('sel'));
    });
    overlay.querySelector('#egg-undo').addEventListener('click', () => {
      const img = strokeUndo.pop();
      if (img) { lctx.putImageData(img, 0, 0); syncLayer(); }
    });
    overlay.querySelector('#egg-clear').addEventListener('click', () => {
      strokeUndo.push(lctx.getImageData(0, 0, SIZE, SIZE));
      lctx.clearRect(0, 0, SIZE, SIZE);
      syncLayer();
    });
    overlay.querySelector('#egg-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#egg-save').addEventListener('click', async () => {
      const msg = overlay.querySelector('#egg-msg');
      msg.innerHTML = '';
      const btn = overlay.querySelector('#egg-save');
      btn.disabled = true;
      try {
        // composite for export
        const out = document.createElement('canvas');
        out.width = out.height = SIZE;
        const octx = out.getContext('2d');
        paintBase(octx);
        octx.drawImage(layer, 0, 0);
        const dataUrl = out.toDataURL('image/png');
        const res = await WSHOP.api('/api/drawings', { method: 'POST', body: { dataUrl } });
        onSave({ drawing_id: res.filename, thumb: dataUrl });
        close();
      } catch (err) {
        msg.innerHTML = `<div class="msg err">${err.message}</div>`;
      } finally {
        btn.disabled = false;
      }
    });

    function close() {
      overlay.classList.remove('open');
      overlay.remove(); // rebuild fresh on next open so listeners don't accumulate
    }

    syncLayer();
  }

  return { open };
})();
