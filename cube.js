export function createLivingCube(canvas, options = {}) {
  // Standard alpha canvas: iPadOS/Safari can render a desynchronized
  // canvas on a separate dark compositor layer.
  const ctx = canvas.getContext("2d", { alpha: true });

  canvas.style.background = "transparent";
  canvas.style.backgroundColor = "transparent";
  const cube = {
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    running: true,
    raf: 0,
    seed: options.phaseSeed || 0,
    pulseUntil: 0
  };

  const faces = [
    { axis: "z", sign: 1 },
    { axis: "z", sign: -1 },
    { axis: "x", sign: 1 },
    { axis: "x", sign: -1 },
    { axis: "y", sign: 1 },
    { axis: "y", sign: -1 }
  ];

  function resetCanvasState() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * cube.dpr));
    const height = Math.max(1, Math.round(rect.height * cube.dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      resetCanvasState();
    }
  }

  function rotatePoint([x, y, z], rx, ry, rz) {
    let c = Math.cos(rx), s = Math.sin(rx);
    let ny = y * c - z * s;
    let nz = y * s + z * c;
    y = ny;
    z = nz;

    c = Math.cos(ry);
    s = Math.sin(ry);
    let nx = x * c + z * s;
    nz = -x * s + z * c;
    x = nx;
    z = nz;

    c = Math.cos(rz);
    s = Math.sin(rz);
    nx = x * c - y * s;
    ny = x * s + y * c;

    return [nx, ny, z];
  }

  function project([x, y, z], scale, cx, cy) {
    const perspective = 3.7;
    const k = perspective / (perspective - z);
    return {
      x: cx + x * scale * k,
      y: cy - y * scale * k,
      z
    };
  }

  function facePoint(face, u, v, t) {
    const a = u * 2 - 1;
    const b = v * 2 - 1;

    // Edge mask keeps the cube silhouette hard while allowing the cells inside to move.
    const edgeMask = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
    const waveA = Math.sin(u * 7.4 + v * 4.9 + t * 1.85 + cube.seed);
    const waveB = Math.sin(u * 3.2 - v * 8.1 - t * 1.3 + 1.7);
    const ripple = Math.sin(t * .72 + u * 4.5 + v * 3.1);
    const displacement = edgeMask * (.022 * waveA + .014 * waveB + .006 * ripple);
    const side = face.sign * (1 + displacement);

    if (face.axis === "z") return [a, b, side];
    if (face.axis === "x") return [side, b, a];
    return [a, side, b];
  }

  function buildFace(face, steps, t, rx, ry, rz, scale, cx, cy) {
    const grid = [];
    let zSum = 0;
    let count = 0;

    for (let j = 0; j <= steps; j++) {
      const row = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const v = j / steps;
        const rotated = rotatePoint(facePoint(face, u, v, t), rx, ry, rz);
        const projected = project(rotated, scale, cx, cy);
        row.push({ ...projected, u, v });
        zSum += rotated[2];
        count++;
      }
      grid.push(row);
    }

    return { face, grid, averageZ: zSum / count };
  }

  function drawFaceFill(faceData, steps) {
    const g = faceData.grid;
    const corners = [g[0][0], g[0][steps], g[steps][steps], g[steps][0]];
    const grad = ctx.createLinearGradient(corners[0].x, corners[0].y, corners[2].x, corners[2].y);
    grad.addColorStop(0, "rgba(142,174,215,.050)");
    grad.addColorStop(.55, "rgba(25,31,39,.105)");
    grad.addColorStop(1, "rgba(255,255,255,.015)");

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function drawCells(faceData, steps, t, front) {
    if (!front) return;
    const g = faceData.grid;

    const palette = [
      [100, 218, 255], // cyan
      [116, 164, 255], // blue
      [184, 132, 255], // violet
      [255, 132, 194], // pink
      [255, 194, 112]  // amber
    ];

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const phase = Math.sin(i * 1.93 + j * 2.31 + faceData.face.sign * 2.7 + cube.seed);
        const life = .5 + .5 * Math.sin(t * (1.02 + ((i + j) % 4) * .15) + phase * 4.5 + i * .27 - j * .19);
        const travelling = .5 + .5 * Math.sin(t * 1.82 + i * .56 + j * .31);
        const active = life * .70 + travelling * .30;

        if (active < .82) continue;

        const p1 = g[j][i];
        const p2 = g[j][i + 1];
        const p3 = g[j + 1][i + 1];
        const p4 = g[j + 1][i];
        const intensity = Math.min(1, (active - .82) / .18);
        const color = palette[(i * 3 + j * 5 + Math.floor(t * .65)) % palette.length];
        const [r, gg, b] = color;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.lineTo(p4.x, p4.y);
        ctx.closePath();

        ctx.fillStyle = `rgba(${r},${gg},${b},${.020 + intensity * .095})`;
        ctx.shadowBlur = 9 + intensity * 18;
        ctx.shadowColor = `rgba(${r},${gg},${b},${.25 + intensity * .28})`;
        ctx.fill();
      }
    }

    ctx.restore();
  }

  function drawGrid(faceData, steps, t, front) {
    const g = faceData.grid;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const alphaBase = front ? .42 : .16;
    const lineWidth = front ? 1.0 : .66;

    for (let j = 0; j <= steps; j++) {
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const p = g[j][i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }

      const wave = .5 + .5 * Math.sin(t * 1.24 + j * .72 + cube.seed);
      const rowPalette = ["109,213,255", "132,174,255", "183,145,255", "246,145,199", "240,191,123"];
      const rowColor = rowPalette[(j + Math.floor(t * .28)) % rowPalette.length];
      ctx.strokeStyle = `rgba(${front ? rowColor : "121,146,179"},${alphaBase + wave * .08})`;
      ctx.lineWidth = lineWidth;
      ctx.shadowBlur = front ? 6 + wave * 7 : 3;
      ctx.shadowColor = front ? `rgba(${rowColor},.42)` : "rgba(102,160,238,.32)";
      ctx.stroke();
    }

    for (let i = 0; i <= steps; i++) {
      ctx.beginPath();
      for (let j = 0; j <= steps; j++) {
        const p = g[j][i];
        if (j === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }

      const wave = .5 + .5 * Math.sin(t * 1.1 + i * .61 + 2.1 + cube.seed);
      ctx.strokeStyle = `rgba(${front ? "226,235,247" : "121,146,179"},${alphaBase * .85 + wave * .07})`;
      ctx.lineWidth = lineWidth;
      ctx.shadowBlur = front ? 5 + wave * 5 : 2;
      ctx.shadowColor = "rgba(160,198,245,.38)";
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawEdges(faceData, steps, front) {
    if (!front) return;
    const g = faceData.grid;
    const corners = [g[0][0], g[0][steps], g[steps][steps], g[steps][0]];

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.lineTo(corners[2].x, corners[2].y);
    ctx.lineTo(corners[3].x, corners[3].y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(222,232,244,.74)";
    ctx.lineWidth = 1.7;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "rgba(110,164,235,.48)";
    ctx.stroke();
    ctx.restore();
  }

  function drawPulse(w, h, cx, cy) {
    const remaining = cube.pulseUntil - performance.now();
    if (remaining <= 0) return;

    const p = 1 - remaining / 850;
    const radius = (42 + p * 120) * cube.dpr;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, `rgba(180,213,255,${.12 * (1 - p)})`);
    glow.addColorStop(.55, `rgba(110,169,244,${.09 * (1 - p)})`);
    glow.addColorStop(1, "rgba(110,169,244,0)");

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function frame() {
    if (!cube.running) return;
    resize();

    const w = canvas.width;
    const h = canvas.height;
    const dpr = cube.dpr;
    const t = performance.now() / 1000;

    resetCanvasState();

    const cx = w * (options.centerX ?? .5) + Math.sin(t * .66 + cube.seed) * 8 * dpr;
    const cy = h * (options.centerY ?? .49) + Math.sin(t * .90 + 1.2 + cube.seed) * 12 * dpr;
    const scale = Math.min(w, h) * (options.scaleFactor ?? .238);

    // Noticeably more movement than the old brain, but still premium and controlled.
    const rx = -.48 + Math.sin(t * .52 + cube.seed) * .12;
    const ry = t * .22 + Math.sin(t * .38 + 1.4) * .23;
    const rz = Math.sin(t * .41 + 2.4) * .07;
    const steps = 11;

    const renderedFaces = faces
      .map(face => buildFace(face, steps, t, rx, ry, rz, scale, cx, cy))
      .sort((a, b) => a.averageZ - b.averageZ);

    renderedFaces.forEach(face => drawFaceFill(face, steps));
    renderedFaces.forEach(face => {
      const front = face.averageZ > 0;
      drawCells(face, steps, t, front);
      drawGrid(face, steps, t, front);
      drawEdges(face, steps, front);
    });

    drawPulse(w, h, cx, cy);
    cube.raf = requestAnimationFrame(frame);
  }

  frame();

  return {
    pulse() {
      cube.pulseUntil = performance.now() + 850;
    },
    destroy() {
      cube.running = false;
      cancelAnimationFrame(cube.raf);
    }
  };
}

/* =========================================================
   INSIDE THE CUBE
   Full-screen animated tunnel/grid used behind lists/search/detail.
========================================================= */

export function createInteriorField(canvas, options = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });

  const field = {
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    raf: 0,
    running: true,
    seed: options.seed || 0,
    intensity: options.intensity ?? 1
  };

  const palette = [
    [100, 218, 255],
    [116, 164, 255],
    [184, 132, 255],
    [255, 132, 194],
    [255, 194, 112]
  ];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * field.dpr));
    const height = Math.max(1, Math.round(rect.height * field.dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function isVisible() {
    const view = canvas.closest(".view");
    return !view || view.classList.contains("view-active");
  }

  function meshPoint(u, v, t, layer = 0) {
    const w = canvas.width;
    const h = canvas.height;
    const dpr = field.dpr;

    const nx = (u - .5) * 2;
    const ny = (v - .5) * 2;

    // A broad barrel/perspective warp makes the grid feel like a field
    // around the viewer instead of a rectangular tunnel with a back wall.
    const r2 = nx * nx + ny * ny;
    const spread = 1 + r2 * (.095 + layer * .018);

    const driftX = Math.sin(t * .38 + field.seed + layer) * 11 * dpr;
    const driftY = Math.cos(t * .43 + 1.2 + field.seed + layer) * 9 * dpr;

    const waveX =
      Math.sin(t * .78 + v * 7.2 + u * 2.6 + field.seed + layer) *
      (4.5 + layer * 1.2) * dpr;

    const waveY =
      Math.cos(t * .70 + u * 6.1 - v * 2.9 + 1.4 + field.seed + layer) *
      (4.0 + layer) * dpr;

    const twist = Math.sin(t * .22 + field.seed + layer) * .017;
    let x = nx * w * (.55 + layer * .10) * spread;
    let y = ny * h * (.56 + layer * .08) * spread;

    const c = Math.cos(twist);
    const s = Math.sin(twist);
    const rx = x * c - y * s;
    const ry = x * s + y * c;

    return [
      w * .52 + rx + waveX * (1 - Math.min(1, r2 * .12)) + driftX,
      h * .49 + ry + waveY * (1 - Math.min(1, r2 * .12)) + driftY
    ];
  }

  function drawMeshLayer(t, layer, alphaScale) {
    const cols = layer === 0 ? 11 : 9;
    const rows = layer === 0 ? 17 : 13;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      ctx.beginPath();

      for (let s = 0; s <= 28; s++) {
        const v = s / 28;
        const [x, y] = meshPoint(u, v, t, layer);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const color = palette[(c + layer * 2 + Math.floor(t * .22)) % palette.length];
      const pulse = .5 + .5 * Math.sin(t * .95 + c * .57 + layer + field.seed);

      ctx.strokeStyle =
        `rgba(${color[0]},${color[1]},${color[2]},${(.030 + pulse * .020) * alphaScale * field.intensity})`;
      ctx.lineWidth = (.52 + layer * .08) * field.dpr;
      ctx.shadowBlur = 3.8 * field.dpr;
      ctx.shadowColor =
        `rgba(${color[0]},${color[1]},${color[2]},${.075 * alphaScale * field.intensity})`;
      ctx.stroke();
    }

    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      ctx.beginPath();

      for (let s = 0; s <= 28; s++) {
        const u = s / 28;
        const [x, y] = meshPoint(u, v, t, layer);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      const pulse = .5 + .5 * Math.sin(t * .84 + r * .49 + layer * 1.8);
      ctx.strokeStyle =
        `rgba(195,214,238,${(.026 + pulse * .017) * alphaScale * field.intensity})`;
      ctx.lineWidth = .50 * field.dpr;
      ctx.shadowBlur = 3 * field.dpr;
      ctx.shadowColor = "rgba(114,165,232,.06)";
      ctx.stroke();
    }

    // Living cells: same family as the start cube, but much quieter.
    if (layer === 0) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const life =
            .5 +
            .5 * Math.sin(
              t * (1.00 + ((r + c) % 4) * .11) +
              r * 1.63 +
              c * 2.07 +
              field.seed
            );

          const travelling =
            .5 + .5 * Math.sin(t * 1.48 + c * .59 + r * .35);

          const active = life * .73 + travelling * .27;
          if (active < .89) continue;

          const p1 = meshPoint(c / cols, r / rows, t, layer);
          const p2 = meshPoint((c + 1) / cols, r / rows, t, layer);
          const p3 = meshPoint((c + 1) / cols, (r + 1) / rows, t, layer);
          const p4 = meshPoint(c / cols, (r + 1) / rows, t, layer);

          const color =
            palette[(c * 3 + r * 5 + Math.floor(t * .52)) % palette.length];

          const intensity = Math.min(1, (active - .89) / .11);

          ctx.beginPath();
          ctx.moveTo(...p1);
          ctx.lineTo(...p2);
          ctx.lineTo(...p3);
          ctx.lineTo(...p4);
          ctx.closePath();

          ctx.fillStyle =
            `rgba(${color[0]},${color[1]},${color[2]},${(.012 + intensity * .050) * field.intensity})`;
          ctx.shadowBlur = (7 + intensity * 11) * field.dpr;
          ctx.shadowColor =
            `rgba(${color[0]},${color[1]},${color[2]},${.13 * field.intensity})`;
          ctx.fill();
        }
      }
    }

    ctx.restore();
  }

  function drawDepthHints(t) {
    const w = canvas.width;
    const h = canvas.height;
    const cx = w * .53 + Math.sin(t * .32 + field.seed) * 16 * field.dpr;
    const cy = h * .47 + Math.cos(t * .36 + field.seed) * 12 * field.dpr;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = .45 * field.dpr;

    const starts = [
      [0, h * .08], [0, h * .30], [0, h * .72], [0, h * .94],
      [w, h * .10], [w, h * .34], [w, h * .68], [w, h * .92],
      [w * .16, 0], [w * .42, 0], [w * .72, 0],
      [w * .18, h], [w * .48, h], [w * .78, h]
    ];

    for (let i = 0; i < starts.length; i++) {
      const color = palette[(i + Math.floor(t * .18)) % palette.length];
      const alpha = .012 + .007 * (.5 + .5 * Math.sin(t * .7 + i));
      ctx.beginPath();
      ctx.moveTo(starts[i][0], starts[i][1]);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha * field.intensity})`;
      ctx.stroke();
    }

    ctx.restore();
  }

  function frame() {
    if (!field.running) return;
    resize();

    if (!isVisible()) {
      field.raf = requestAnimationFrame(frame);
      return;
    }

    const w = canvas.width;
    const h = canvas.height;
    const t = performance.now() / 1000;

    // Own the entire view background. No inner rectangle / far wall.
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#040609";
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(
      w * .52, h * .48, 0,
      w * .52, h * .48, Math.max(w, h) * .78
    );
    glow.addColorStop(0, "rgba(72,104,149,.050)");
    glow.addColorStop(.42, "rgba(84,62,115,.021)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    drawDepthHints(t);
    drawMeshLayer(t, 1, .56);
    drawMeshLayer(t, 0, .92);

    field.raf = requestAnimationFrame(frame);
  }

  frame();

  return {
    destroy() {
      field.running = false;
      cancelAnimationFrame(field.raf);
    }
  };
}

