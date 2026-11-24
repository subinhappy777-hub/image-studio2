import {
  state,
  canvas,
  render,
  updateCanvasSize,
  setStatus,
  measureTextLayout,
  AUTO_LAYOUT,
  fitTextToCanvas,
  findFreeTextPosition,
  reflowAllTexts
} from "./state.js";

import { handleFile } from "./file-validation.js";

import {
  createTemplate,
  openTemplateModal,
  closeTemplateModal,
  exportToJson,
  importFromJson
} from "./template.js";

import {
  getCustomStickers,
  addCustomSticker,
  deleteCustomSticker,
  addCustomFont,
  restoreCustomFonts
} from "./assets-library.js";

import { BUILTIN_STICKERS } from "./sticker-assets.js";

// ======================================
// 1. 기본 설정
// ======================================

const $ = id => document.getElementById(id);

let activeTool = "text";
let drag = null;
let selectedStickerData = null;
let selectedSplitSlotIndex = null;

const history = [];
const HISTORY_LIMIT = 30;

// ======================================
// 2. 편집 기록 저장 (Undo)
// ======================================

function snapshot() {
  return {
    aspectRatio: state.aspectRatio,

    texts: structuredClone(state.texts),
    drawings: structuredClone(state.drawings),
    stickers: structuredClone(state.stickers),

    imageX: state.imageX,
    imageY: state.imageY,
    imageScale: state.imageScale,
    imageScaleX: state.imageScaleX,
    imageScaleY: state.imageScaleY,
    imageFit: state.imageFit,
    imageRotation: state.imageRotation,

    background: state.background,
    frameType: state.frameType || "none",
    frameColor: state.frameColor,
    frameWidth: state.frameWidth,

    // 사진 분할 상태 저장
    splitLayout: state.splitLayout,
    splitImages: [...(state.splitImages || [])],
    splitImageTransforms: structuredClone(state.splitImageTransforms || [])
  };
}

function remember() {
  history.push(snapshot());

  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
}

function undo() {
  const previous = history.pop();

  if (!previous) {
    setStatus("되돌릴 작업이 없습니다.");
    return;
  }

  Object.assign(state, previous);

  state.selectedTextId = null;
  state.selectedStickerId = null;
  state.imageSelected = false;
  state.selectedSplitImageIndex = null;
  selectedSplitSlotIndex = null;

  // ★ 이미지/화면비 설정 복원 + UI 동기화
  $("aspectRatio").value = state.aspectRatio;
  $("imageScale").value =
    String(Math.round(getSelectedImageScale() * 100));
  $("imageWidthScale").value = String(Math.round(getSelectedImageAxisScale("X") * 100));
  $("imageHeightScale").value = String(Math.round(getSelectedImageAxisScale("Y") * 100));
  $("imageFit").value = state.imageFit || "cover";

  $("bgColor").value = state.background;
  $("frameType").value = state.frameType || "none";
  $("frameColor").value = state.frameColor;
  $("frameWidth").value = String(state.frameWidth);
  $("frameWidthValue").textContent = String(state.frameWidth);
  updateFrameControls();

  // ★ 선택 컨트롤 초기화
  $("stickerSize").value = "120";
  $("stickerRotation").value = "0";

  // 사진 분할 레이아웃 화면 복원
  syncSplitLayoutUI();
  syncImageScaleControl();

  // ★ 캔버스 크기 복원 (내부에서 render() 호출됨)
  updateCanvasSize();

  setStatus("이전 편집 상태로 되돌렸습니다.");
}

// ======================================
// 편집 조작당 Undo 기록을 한 번만 저장
// ======================================

function bindUndoStart(element, condition = () => true) {
  if (!element) return;

  let isRecorded = false;

  const startEdit = () => {
    if (isRecorded) return;
    if (!condition()) return;

    remember();

    isRecorded = true;
  };

  const finishEdit = () => {
    isRecorded = false;
  };

  element.addEventListener("pointerdown", startEdit);

  // ★ keydown 대신 input에서 1회 기록 (중복 기록 방지)
  element.addEventListener("input", () => {
    if (!isRecorded) startEdit();
  });

  // 실제 변경이 끝났거나 입력창에서 벗어났을 때 초기화
  element.addEventListener("change", finishEdit);
  element.addEventListener("blur", finishEdit);
  element.addEventListener("pointercancel", finishEdit);
}

// ======================================
// 3. 캔버스 좌표 계산
// ======================================

function getCoords(event) {
  const rect = canvas.getBoundingClientRect();

  return {
    x: (event.clientX - rect.left) / rect.width * 100,
    y: (event.clientY - rect.top) / rect.height * 100
  };
}

// ======================================
// 4. 도구 선택
// ======================================

document.querySelectorAll(".tool-btn").forEach(button => {
  button.addEventListener("click", () => {
    const tool = button.dataset.tool;

    if (tool === "undo") {
      undo();
      return;
    }

    activeTool = tool;
    state.imageEditing = tool === "image";

    document.querySelectorAll(".tool-btn").forEach(btn => {
      const isSelected = btn === button;

      btn.classList.toggle("active", isSelected);

      if (btn.dataset.tool !== "undo") {
        btn.setAttribute("aria-pressed", String(isSelected));
      }
    });

    document.querySelectorAll(".opt-content").forEach(panel => {
      panel.classList.toggle(
        "active",
        panel.id === `opt-${tool}`
      );
    });

    if (tool === "draw") {
      canvas.style.cursor = "crosshair";
    } else if (tool === "text") {
      canvas.style.cursor = "text";
    } else if (tool === "image") {
      canvas.style.cursor = "grab";
    } else {
      canvas.style.cursor = "default";
    }

    if (typeof splitOverlay !== "undefined") syncSplitLayoutUI();
    render();

    setStatus(
      `"${button.querySelector("span").textContent}" 도구가 활성화되었습니다.`
    );
  });
});

// ======================================
// 5. 문구 추가 및 동기화
// ======================================

function addText(value, x = null, y = null) {
  const originalText = String(value ?? "");

  // 공백만 입력한 경우에만 추가를 막음
  if (!originalText.trim()) {
    setStatus("문구를 입력해 주세요.", true);
    return;
  }

  remember();

  const base = {
    id: crypto.randomUUID(),
    text: originalText.slice(0, 300),
    fontSize: Number($("fontSize").value),
    fontFamily: $("fontFamily").value,
    color: $("colorInput").value,
    bold: $("fontBold").checked,
    x: 50,
    y: 50
  };

  let finalX;
  let finalY;
  let finalSize;

  if (x === null || y === null) {
    // ★ 자동 배치: 겹치지 않는 위치 + 공간 부족 시 축소
    const pos = findFreeTextPosition(base);
    finalX = pos.x;
    finalY = pos.y;
    finalSize = pos.fontSize;
  } else {
    // 사용자가 캔버스 클릭한 좌표 사용
    finalX = x;
    finalY = y;

    // ★ 세로 초과 방지 + 자동 축소
    const fitted = fitTextToCanvas({ ...base, x, y });
    finalSize = fitted.fontSize;

    // clamp된 y 재계산
    finalY = (fitted.layout.centerY / canvas.height) * 100;
  }

  const item = {
    ...base,
    x: finalX,
    y: finalY,
    fontSize: finalSize
  };

  state.texts.push(item);
  state.selectedTextId = item.id;

  // ★ 추가 후 UI 슬라이더 동기화
  $("fontSize").value = String(finalSize);
  $("fontSizeValue").textContent = String(finalSize);

  render();
  setStatus("문구를 추가했습니다.");
}

function selectedText() {
  return state.texts.find(
    text => text.id === state.selectedTextId
  ) || null;
}

// ======================================
// 6. 실제 텍스트 영역으로 선택
// ======================================

function pickText(x, y) {
  // 마우스 좌표는 퍼센트이므로 실제 캔버스 픽셀로 변환
  const pointerX = x * canvas.width / 100;
  const pointerY = y * canvas.height / 100;

  // 나중에 추가한 텍스트부터 선택
  return [...state.texts].reverse().find(text => {
    const layout = measureTextLayout(text);
    const bounds = layout.bounds;

    // 글자 외곽을 조금 더 쉽게 선택할 수 있도록 여유 공간 추가
    const padding = Math.max(6, layout.fontSize * 0.12);

    return (
      pointerX >= bounds.left - padding &&
      pointerX <= bounds.right + padding &&
      pointerY >= bounds.top - padding &&
      pointerY <= bounds.bottom + padding
    );
  });
}

function syncTextControls(text) {
  $("textInput").value = text.text;
  $("fontSize").value = String(text.fontSize);
  $("fontSizeValue").textContent = String(text.fontSize);
  $("colorInput").value = text.color;
  $("fontFamily").value = text.fontFamily;
  $("fontBold").checked = text.bold || false;
}

// ======================================
// 7. 스티커 패널 동적 렌더링
// ======================================

function renderStickerPanel() {
  const grid = $("stickerGrid");

  if (!grid) return;

  grid.innerHTML = "";

  const categories = [
    { key: "animal", title: "동물 귀/수염" },
    { key: "crown", title: "👑 왕관" },
    { key: "glasses", title: "👓 안경" },
    { key: "sunglasses", title: "😎 선글라스" },
    { key: "speech", title: "💬 유행어 말풍선" },
    { key: "emoji", title: "기본 이모지" },
    { key: "custom", title: "🎨 내 스티커" }
  ];

  categories.forEach(cat => {
    const title = document.createElement("h3");

    title.textContent = cat.title;

    grid.appendChild(title);

    const container = document.createElement("div");

    container.className = "sticker-grid";

    let items = BUILTIN_STICKERS[cat.key] || [];

    if (cat.key === "custom") {
      items = getCustomStickers();
    }

    items.forEach(item => {
      // 스티커와 삭제 버튼을 담는 별도 영역
      const wrapper = document.createElement("div");

      wrapper.className = "sticker-card";

      // 스티커 선택 버튼
      const btn = document.createElement("button");

      btn.type = "button";
      btn.className = "sticker-item";

      if (item.kind === "emoji") {
        btn.textContent = item.emoji;
      } else if (item.kind === "speech") {
        btn.textContent = item.text;
        btn.classList.add("speech-bubble");
      } else if (item.kind === "image") {
        const img = document.createElement("img");

        img.src = item.src;
        img.alt = item.name || "사용자 스티커";

        btn.appendChild(img);
      }

      btn.addEventListener("click", () => {
        selectedStickerData = item;
        $("speechStyleControls").hidden = item.kind !== "speech";

        state.selectedStickerId = null;

        activeTool = "sticker";

        document.querySelectorAll(".tool-btn").forEach(toolBtn => {
          const isSelected =
            toolBtn.dataset.tool === "sticker";

          toolBtn.classList.toggle("active", isSelected);

          if (toolBtn.dataset.tool !== "undo") {
            toolBtn.setAttribute(
              "aria-pressed",
              String(isSelected)
            );
          }
        });

        document.querySelectorAll(".opt-content").forEach(panel => {
          panel.classList.toggle(
            "active",
            panel.id === "opt-sticker"
          );
        });

        document.querySelectorAll(".sticker-item").forEach(stickerBtn => {
          stickerBtn.classList.remove("selected");
        });

        btn.classList.add("selected");

        setStatus(
          `"${item.name}" 스티커를 선택했습니다. 이미지를 클릭해 붙여보세요.`
        );
      });

      wrapper.appendChild(btn);

      // 커스텀 스티커 삭제 버튼
      if (cat.key === "custom") {
        const delBtn = document.createElement("button");

        delBtn.type = "button";
        delBtn.className = "custom-sticker-delete";

        delBtn.textContent = "✕";
        delBtn.title = "이 스티커 삭제";
        delBtn.setAttribute("aria-label", `${item.name} 스티커 삭제`);

        delBtn.addEventListener("click", e => {
          e.stopPropagation();

          if (
            confirm(`"${item.name}" 스티커를 삭제하시겠습니까?`)
          ) {
            deleteCustomSticker(item.id);

            renderStickerPanel();

            setStatus("커스텀 스티커가 삭제되었습니다.");
          }
        });

        wrapper.appendChild(delBtn);
      }

      container.appendChild(wrapper);
    });

    grid.appendChild(container);
  });
}

// ======================================
// 8. 스티커 추가 및 선택
// ======================================

function addSticker(x, y) {
  if (!selectedStickerData) {
    setStatus(
      "먼저 스티커 창에서 스티커를 선택해 주세요.",
      true
    );
    return;
  }

  remember();

  const sticker = {
    id: crypto.randomUUID(),
    x,
    y,
    size: Number($("stickerSize")?.value) || 120,
    rotation: 0,
    kind: selectedStickerData.kind,
    name: selectedStickerData.name
  };

  if (selectedStickerData.kind === "emoji") {
    sticker.emoji = selectedStickerData.emoji;
  } else if (selectedStickerData.kind === "speech") {
    sticker.text = selectedStickerData.text;
    sticker.speechShape = $("speechShape").value;
    sticker.speechFill = $("speechFill").value;
    sticker.speechOutline = $("speechOutline").checked;
  } else if (selectedStickerData.kind === "image") {
    sticker.src = selectedStickerData.src;
  }

  state.stickers.push(sticker);
  state.selectedStickerId = sticker.id;

  render();
  setStatus("스티커를 추가했습니다.");
}

function pickSticker(x, y) {
  // ★ 회전 반영 히트박스
  const px = x * canvas.width / 100;
  const py = y * canvas.height / 100;

  return [...state.stickers].reverse().find(sticker => {
    const cx = (Number(sticker.x) || 0) * canvas.width / 100;
    const cy = (Number(sticker.y) || 0) * canvas.height / 100;
    const size = Number(sticker.size) || 120;
    let halfWidth = size / 2;
    let halfHeight = size / 2;
    if (sticker.kind === "speech") {
      const textWidth = String(sticker.text || "").length * size * 0.2;
      halfWidth = Math.max(halfWidth, (textWidth + size * 0.4) / 2);
      halfHeight = Math.max(halfHeight, size * 0.4);
      if ((sticker.speechShape || "rounded") === "circle") {
        halfWidth = halfHeight = Math.max(halfWidth, halfHeight);
      }
    }

    // 클릭 좌표를 스티커 회전의 역방향으로 회전
    const rad = -(Number(sticker.rotation) || 0) * Math.PI / 180;
    const dx = px - cx;
    const dy = py - cy;
    const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
    const localY = dx * Math.sin(rad) + dy * Math.cos(rad);

    return (
      Math.abs(localX) <= halfWidth &&
      Math.abs(localY) <= halfHeight
    );
  });
}

// ======================================
// 9. 스티커 설정 이벤트
// ======================================

// ★ 스티커 크기: bindUndoStart + input으로 실시간 반영 + 1회 기록
bindUndoStart($("stickerSize"), () => !!state.selectedStickerId);
$("stickerSize").addEventListener("input", e => {
  const sticker = state.stickers.find(
    s => s.id === state.selectedStickerId
  );

  if (!sticker) return;

  sticker.size = Number(e.target.value);
  render();
});

// 스티커 회전 변경 전 Undo 기록
bindUndoStart(
  $("stickerRotation"),
  () => !!state.stickers.find(
    s => s.id === state.selectedStickerId
  )
);

// 스티커 회전 실시간 변경
$("stickerRotation")?.addEventListener("input", e => {
  const sticker = state.stickers.find(
    s => s.id === state.selectedStickerId
  );

  if (!sticker) return;

  sticker.rotation = Number(e.target.value);

  render();
});

// 스티커 회전 조작 종료
$("stickerRotation")?.addEventListener("change", () => {
  const sticker = state.stickers.find(
    s => s.id === state.selectedStickerId
  );

  if (!sticker) return;

  setStatus("스티커를 회전했습니다.");
});

function updateSelectedSpeechStyle() {
  const sticker = state.stickers.find(item => item.id === state.selectedStickerId);
  if (!sticker || sticker.kind !== "speech") return;

  remember();
  sticker.speechShape = $("speechShape").value;
  sticker.speechFill = $("speechFill").value;
  sticker.speechOutline = $("speechOutline").checked;
  render();
}

$("speechShape").addEventListener("change", updateSelectedSpeechStyle);
$("speechFill").addEventListener("change", updateSelectedSpeechStyle);
$("speechOutline").addEventListener("change", updateSelectedSpeechStyle);

$("deleteStickerBtn").addEventListener("click", () => {
  if (!state.selectedStickerId) {
    setStatus("삭제할 스티커를 먼저 선택하세요.", true);
    return;
  }

  remember();

  state.stickers = state.stickers.filter(
    s => s.id !== state.selectedStickerId
  );

  state.selectedStickerId = null;

  render();
  setStatus("선택한 스티커를 삭제했습니다.");
});

$("clearAllStickersBtn")?.addEventListener("click", () => {
  if (state.stickers.length === 0) {
    setStatus("삭제할 스티커가 없습니다.", true);
    return;
  }

  if (!confirm("캔버스에 붙인 모든 스티커를 삭제하시겠습니까?")) {
    return;
  }

  remember();

  state.stickers = [];
  state.selectedStickerId = null;

  render();
  setStatus("캔버스의 모든 스티커를 삭제했습니다.");
});

// ======================================
// 10. 텍스트 설정 이벤트
// ======================================

// 텍스트 입력 전 Undo 기록
bindUndoStart($("textInput"), () => !!selectedText());

// 글자 크기 변경 전 Undo 기록
bindUndoStart($("fontSize"), () => !!selectedText());

// 글자 색상 변경 전 Undo 기록
bindUndoStart($("colorInput"), () => !!selectedText());

// 텍스트 추가
$("addTextBtn").addEventListener("click", () => {
  addText($("textInput").value);
});

// 텍스트 내용 실시간 수정
$("textInput").addEventListener("input", e => {
  const text = selectedText();

  if (!text) return;

  text.text = e.target.value.slice(0, 300);

  // ★ 내용이 길어져 캔버스를 넘으면 자동 축소
  const { fontSize, layout } = fitTextToCanvas(text);
  text.fontSize = fontSize;
  text.y = (layout.centerY / canvas.height) * 100;

  // UI 슬라이더 동기화
  $("fontSize").value = String(fontSize);
  $("fontSizeValue").textContent = String(fontSize);

  render();
});

// 글자 크기 변경
$("fontSize").addEventListener("input", e => {
  const text = selectedText();

  if (!text) {
    $("fontSizeValue").textContent = e.target.value;
    return;
  }

  text.fontSize = Number(e.target.value);

  // ★ 사용자가 크게 올려도 캔버스 넘으면 자동 축소
  const { fontSize, layout } = fitTextToCanvas(text);
  text.fontSize = fontSize;
  text.y = (layout.centerY / canvas.height) * 100;

  $("fontSize").value = String(fontSize);
  $("fontSizeValue").textContent = String(fontSize);

  render();
});

// 글자 색상 변경
$("colorInput").addEventListener("input", e => {
  const text = selectedText();

  if (!text) return;

  text.color = e.target.value;
  render();
});

// 글꼴 변경
$("fontFamily").addEventListener("change", e => {
  const text = selectedText();

  if (!text) return;

  remember();

  text.fontFamily = e.target.value;

  render();
});

// 굵게 설정
$("fontBold").addEventListener("change", e => {
  const text = selectedText();

  if (!text) return;

  remember();

  text.bold = e.target.checked;

  render();
});

// ======================================
// 11. 이미지 설정
// ======================================

// ★ 배경색: 색상 피커 드래그 중 1회만 기록
bindUndoStart($("bgColor"), () => true);
$("bgColor").addEventListener("input", e => {
  state.background = e.target.value;
  render();
});

// ★ 이미지 크기: 슬라이더 잡을 때 1회 기록
function isSplitMode() {
  return [2, 4, 9].includes(state.splitLayout);
}

function getSelectedImageScale() {
  if (isSplitMode() && selectedSplitSlotIndex !== null) {
    return state.splitImageTransforms?.[selectedSplitSlotIndex]?.scale ?? 1;
  }
  return state.imageScale;
}

function getSelectedImageAxisScale(axis) {
  if (isSplitMode() && selectedSplitSlotIndex !== null) {
    return state.splitImageTransforms?.[selectedSplitSlotIndex]?.[`scale${axis}`] ?? 1;
  }
  return state[`imageScale${axis}`] ?? 1;
}

function syncImageScaleControl() {
  const hasSplitSelection = isSplitMode() && selectedSplitSlotIndex !== null && !!state.splitImages[selectedSplitSlotIndex];
  const hasImage = hasSplitSelection || (!isSplitMode() && !!state.image);
  const slotLabel = hasSplitSelection ? `${selectedSplitSlotIndex + 1}번 칸 ` : "";

  $("imageScale").disabled = !hasImage;
  $("imageScale").value = String(Math.round(getSelectedImageScale() * 100));
  $("imageScaleLabel").textContent = hasImage ? `${slotLabel}사진 크기` : "사진 크기";

  $("imageWidthScale").disabled = !hasImage;
  $("imageWidthScale").value = String(Math.round(getSelectedImageAxisScale("X") * 100));
  $("imageWidthScaleLabel").textContent = `${slotLabel}가로 늘이기`;

  $("imageHeightScale").disabled = !hasImage;
  $("imageHeightScale").value = String(Math.round(getSelectedImageAxisScale("Y") * 100));
  $("imageHeightScaleLabel").textContent = `${slotLabel}세로 늘이기`;
  $("imageFit").disabled = isSplitMode();
  $("imageFit").value = state.imageFit || "cover";
}

$("imageFit").addEventListener("change", e => {
  remember();
  state.imageFit = e.target.value === "contain" ? "contain" : "cover";
  render();
});

bindUndoStart($("imageScale"), () =>
  isSplitMode()
    ? selectedSplitSlotIndex !== null && !!state.splitImages[selectedSplitSlotIndex]
    : !!state.image
);
$("imageScale").addEventListener("input", e => {
  const scale = Number(e.target.value) / 100;
  if (isSplitMode() && selectedSplitSlotIndex !== null && state.splitImages[selectedSplitSlotIndex]) {
    state.splitImageTransforms[selectedSplitSlotIndex].scale = scale;
  } else if (state.image) {
    state.imageScale = scale;
  }
  render();
});

for (const [axis, inputId] of [["X", "imageWidthScale"], ["Y", "imageHeightScale"]]) {
  bindUndoStart($(inputId), () =>
    isSplitMode()
      ? selectedSplitSlotIndex !== null && !!state.splitImages[selectedSplitSlotIndex]
      : !!state.image
  );
  $(inputId).addEventListener("input", e => {
    const value = Number(e.target.value) / 100;
    if (isSplitMode() && selectedSplitSlotIndex !== null && state.splitImages[selectedSplitSlotIndex]) {
      state.splitImageTransforms[selectedSplitSlotIndex][`scale${axis}`] = value;
    } else if (state.image) {
      state[`imageScale${axis}`] = value;
    }
    render();
  });
}

// ★ 프레임: select change 1회 기록
$("frameType").addEventListener("change", e => {
  remember();
  state.frameType = e.target.value;
  updateFrameControls();
  render();
});

function updateFrameControls() {
  $("solidFrameControls").hidden = state.frameType !== "solid";
}

function updateGradientControls() {
  $("gradientControls").hidden = $("brushColorMode").value !== "gradient";
}

$("brushColorMode").addEventListener("change", updateGradientControls);
$("gradientAngle").addEventListener("input", e => {
  $("gradientAngleValue").textContent = `${e.target.value}°`;
});

bindUndoStart($("frameColor"));
$("frameColor").addEventListener("input", e => {
  state.frameColor = e.target.value;
  render();
});

bindUndoStart($("frameWidth"));
$("frameWidth").addEventListener("input", e => {
  state.frameWidth = Number(e.target.value);
  $("frameWidthValue").textContent = String(state.frameWidth);
  render();
});

// ======================================
// 12. 이미지 업로드 및 분할
// ======================================

const fileInput = $("fileInput");
const uploadPlaceholder = $("uploadPlaceholder");
const btnInput = $("btnInput");

btnInput?.addEventListener("click", () => {
  if (isSplitMode()) {
    const emptySlotIndex = state.splitImages.findIndex(image => !image);
    const targetSlotIndex = selectedSplitSlotIndex ?? emptySlotIndex;

    if (targetSlotIndex < 0) {
      setStatus("사진을 추가하거나 바꿀 칸의 ＋ 버튼을 눌러 주세요.", true);
      return;
    }

    currentSlotIndex = targetSlotIndex;
    slotFileInput?.click();
    return;
  }

  fileInput?.click();
});

uploadPlaceholder?.addEventListener("click", () => fileInput?.click());

fileInput?.addEventListener("change", async e => {
  const file = e.target.files?.[0];

  if (!file) return;

  try {
    // ★ 업로드 성공 직전 remember() 호출 (변경 전 상태 저장)
    await handleFile(file, () => remember());
  } catch (error) {
    console.error("이미지 불러오기 실패:", error);
    alert("이미지를 불러오지 못했습니다.");
  } finally {
    e.target.value = "";
  }
});

// ======================================
// 13. 커스텀 스티커/폰트 추가
// ======================================

$("customStickerInput")?.addEventListener("change", async e => {
  const file = e.target.files?.[0];

  if (file) {
    try {
      await addCustomSticker(file);
      renderStickerPanel();
      setStatus("커스텀 스티커가 추가되었습니다.");
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  e.target.value = "";
});

// ======================================
// 14. 화면비 및 줌 컨트롤
// ======================================

$("aspectRatio").addEventListener("change", e => {
  // ★ Undo 기록
  remember();

  state.aspectRatio = e.target.value;
  updateCanvasSize();

  // ★ 화면비 변경 시 모든 텍스트 자동 재배치/축소
  reflowAllTexts({ shrink: true });
  render();
});

$("zoomInBtn").addEventListener("click", () => {
  if (state.zoomLevel < 2.0) {
    state.zoomLevel += 0.1;
    updateCanvasSize();
  }
});

$("zoomOutBtn").addEventListener("click", () => {
  if (state.zoomLevel > 0.5) {
    state.zoomLevel -= 0.1;
    updateCanvasSize();
  }
});

// ======================================
// 15. 캔버스 마우스/터치 이벤트
// ======================================

function getImageRect(image, transform, slot = null) {
  if (!image) return null;
  const baseWidth = slot?.width ?? canvas.width;
  const baseHeight = slot?.height ?? canvas.height;
  const fit = slot
    ? Math.max(baseWidth / image.naturalWidth, baseHeight / image.naturalHeight) * (transform.scale ?? 1)
    : (state.imageFit === "contain"
        ? Math.min(baseWidth / image.naturalWidth, baseHeight / image.naturalHeight)
        : Math.max(baseWidth / image.naturalWidth, baseHeight / image.naturalHeight)) * state.imageScale;
  return {
    centerX: slot ? slot.x + slot.width * (transform.x ?? 50) / 100 : canvas.width * state.imageX / 100,
    centerY: slot ? slot.y + slot.height * (transform.y ?? 50) / 100 : canvas.height * state.imageY / 100,
    width: image.naturalWidth * fit * (transform.scaleX ?? 1),
    height: image.naturalHeight * fit * (transform.scaleY ?? 1),
    rotation: transform.rotation || 0
  };
}

function imageLocalPoint(rect, x, y) {
  const angle = -(rect.rotation || 0) * Math.PI / 180;
  const dx = x - rect.centerX;
  const dy = y - rect.centerY;
  return {
    x: dx * Math.cos(angle) - dy * Math.sin(angle),
    y: dx * Math.sin(angle) + dy * Math.cos(angle)
  };
}

function getImageInteraction(rect, x, y, slot = null) {
  const local = imageLocalPoint(rect, x, y);
  const handleOffset = Math.max(26, Math.min(42, Math.min(rect.width, rect.height) * 0.14));
  const threshold = Math.max(18, canvas.width * 0.018);
  const radius = Math.max(7, Math.min(11, canvas.width / 110));
  const region = slot || { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const angle = rect.rotation * Math.PI / 180;
  const clampPoint = (pointX, pointY) => [
    Math.max(region.x + radius, Math.min(region.x + region.width - radius, pointX)),
    Math.max(region.y + radius, Math.min(region.y + region.height - radius, pointY))
  ];
  const toWorld = (lx, ly) => clampPoint(
    rect.centerX + lx * Math.cos(angle) - ly * Math.sin(angle),
    rect.centerY + lx * Math.sin(angle) + ly * Math.cos(angle)
  );

  const rotationHandle = toWorld(0, -rect.height / 2 - handleOffset);
  if (Math.hypot(x - rotationHandle[0], y - rotationHandle[1]) <= threshold) {
    return { kind: "rotate" };
  }

  const corners = [
    [-rect.width / 2, -rect.height / 2],
    [rect.width / 2, -rect.height / 2],
    [rect.width / 2, rect.height / 2],
    [-rect.width / 2, rect.height / 2]
  ];
  for (const [cornerX, cornerY] of corners) {
    const handle = toWorld(cornerX, cornerY);
    if (Math.hypot(x - handle[0], y - handle[1]) <= threshold) {
      return { kind: "resize", handleLocal: [cornerX, cornerY] };
    }
  }

  if (Math.abs(local.x) <= rect.width / 2 && Math.abs(local.y) <= rect.height / 2) {
    return { kind: "move" };
  }
  return null;
}

function createImageDrag(interaction, rect, target, x, y, slot = null) {
  const angle = Math.atan2(y - rect.centerY, x - rect.centerX);
  return {
    type: "imageTransform",
    kind: interaction.kind,
    rect,
    target,
    slot,
    startX: x,
    startY: y,
    startAngle: angle,
    startRotation: rect.rotation || 0,
    startScale: target.scale ?? state.imageScale,
    startDistance: Math.max(1, Math.hypot(...(interaction.handleLocal || [x - rect.centerX, y - rect.centerY]))),
    offsetX: x - rect.centerX,
    offsetY: y - rect.centerY
  };
}

canvas.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;

  const point = getCoords(event);

  // 그리기 도구
  if (activeTool === "draw") {
    remember();

    const stroke = {
      points: [point],
      color: $("brushColor").value,
      gradient: $("brushColorMode").value === "gradient",
      colorEnd: $("brushColorEnd").value,
      gradientAngle: Number($("gradientAngle").value),
      size: Number($("brushSize").value),
      autoShape: $("autoShapeEnabled").checked,
      type: $("brushType").value
    };

    state.drawings.push(stroke);

    drag = {
      type: "draw",
      target: stroke
    };

    canvas.setPointerCapture(event.pointerId);
    render();
    return;
  }

  // 문구 도구
  if (activeTool === "text") {
    const text = pickText(point.x, point.y);

    if (text) {
      // ★ 이동 전 상태 기록 (선택만 해도 무해)
      remember();

      state.selectedTextId = text.id;
      syncTextControls(text);

      drag = {
        type: "text",
        target: text,
        offsetX: point.x - text.x,
        offsetY: point.y - text.y,
        moved: false
      };

      canvas.setPointerCapture(event.pointerId);
      render();
    } else {
      addText($("textInput").value, point.x, point.y);
    }

    return;
  }

  // 스티커 도구
  if (activeTool === "sticker") {
    const sticker = pickSticker(point.x, point.y);

    if (sticker) {
      remember();

      state.selectedStickerId = sticker.id;

      $("stickerSize").value = String(sticker.size);
      $("stickerRotation").value =
        String(sticker.rotation || 0);
      $("speechStyleControls").hidden = sticker.kind !== "speech";
      if (sticker.kind === "speech") {
        $("speechShape").value = sticker.speechShape || "rounded";
        $("speechFill").value = sticker.speechFill || "white";
        $("speechOutline").checked = sticker.speechOutline === true;
      }

      drag = {
        type: "sticker",
        target: sticker,
        offsetX: point.x - sticker.x,
        offsetY: point.y - sticker.y
      };

      canvas.setPointerCapture(event.pointerId);
    } else {
      addSticker(point.x, point.y);
    }

    return;
  }

  // 이미지 도구: 사진 본체 이동, 모서리 크기 조절, 상단 손잡이 회전
  if (activeTool === "image") {
    const px = point.x * canvas.width / 100;
    const py = point.y * canvas.height / 100;

    if (isSplitMode()) {
      const slot = getSplitSlotAt(point);
      if (!slot || !state.splitImages[slot.index]) {
        selectedSplitSlotIndex = null;
        state.selectedSplitImageIndex = null;
        state.imageSelected = false;
        render();
        syncImageScaleControl();
        return;
      }

      selectedSplitSlotIndex = slot.index;
      state.selectedSplitImageIndex = slot.index;
      state.imageSelected = false;
      const target = state.splitImageTransforms[slot.index];
      const rect = getImageRect(state.splitImages[slot.index], target, slot);
      const interaction = getImageInteraction(rect, px, py, slot);
      syncSplitLayoutUI();
      syncImageScaleControl();

      if (!interaction) {
        render();
        return;
      }
      remember();
      drag = createImageDrag(interaction, rect, target, px, py, slot);
    } else {
      if (!state.image) return;
      const target = {
        x: state.imageX,
        y: state.imageY,
        scale: state.imageScale,
        rotation: state.imageRotation,
        scaleX: state.imageScaleX,
        scaleY: state.imageScaleY
      };
      const rect = getImageRect(state.image, target);
      const interaction = getImageInteraction(rect, px, py);
      if (!interaction) {
        state.imageSelected = false;
        render();
        return;
      }
      state.imageSelected = true;
      state.selectedSplitImageIndex = null;
      remember();
      drag = createImageDrag(interaction, rect, target, px, py);
    }

    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = drag.kind === "move" ? "grabbing" : drag.kind === "rotate" ? "crosshair" : "nwse-resize";
    render();
    return;
  }
});

canvas.addEventListener("pointermove", event => {
  if (!drag) return;

  const point = getCoords(event);

  if (drag.type === "text") {
    drag.moved = true;

    let nx = point.x - drag.offsetX;
    let ny = point.y - drag.offsetY;

    // ★ 드래그 중에도 캔버스 세로 영역 안으로 clamp
    const layout = measureTextLayout({
      ...drag.target,
      x: nx,
      y: ny
    });

    const marginPct =
      (AUTO_LAYOUT.CANVAS_MARGIN / canvas.height) * 100;
    const halfHPct =
      (layout.bounds.height / canvas.height) * 50;

    ny = Math.max(
      marginPct + halfHPct,
      Math.min(100 - marginPct - halfHPct, ny)
    );

    drag.target.x = nx;
    drag.target.y = ny;
  } else if (drag.type === "draw") {
    drag.target.points.push(point);
  } else if (drag.type === "sticker") {
    drag.target.x = point.x - drag.offsetX;
    drag.target.y = point.y - drag.offsetY;
  } else if (drag.type === "imageTransform") {
    const px = point.x * canvas.width / 100;
    const py = point.y * canvas.height / 100;
    if (drag.kind === "move") {
      if (drag.slot) {
        drag.target.x = Math.max(0, Math.min(100, (px - drag.offsetX - drag.slot.x) / drag.slot.width * 100));
        drag.target.y = Math.max(0, Math.min(100, (py - drag.offsetY - drag.slot.y) / drag.slot.height * 100));
      } else {
        state.imageX = Math.max(-50, Math.min(150, point.x - drag.offsetX));
        state.imageY = Math.max(-50, Math.min(150, point.y - drag.offsetY));
      }
    } else if (drag.kind === "resize") {
      const distance = Math.hypot(px - drag.rect.centerX, py - drag.rect.centerY);
      const ratio = Math.max(0.2, Math.min(4, distance / drag.startDistance));
      const nextScale = Math.max(0.2, Math.min(3, drag.startScale * ratio));
      if (drag.slot) drag.target.scale = nextScale;
      else state.imageScale = nextScale;
    } else if (drag.kind === "rotate") {
      const angle = Math.atan2(py - drag.rect.centerY, px - drag.rect.centerX);
      const delta = (angle - drag.startAngle) * 180 / Math.PI;
      const rotation = ((drag.startRotation + delta + 180) % 360 + 360) % 360 - 180;
      if (drag.slot) drag.target.rotation = rotation;
      else state.imageRotation = rotation;
    }
  } else if (drag.type === "splitImage") {
    const distance = Math.hypot(
      (point.x - drag.startX) * canvas.width / 100,
      (point.y - drag.startY) * canvas.height / 100
    );
    if (!drag.moved && distance < 4) return;
    drag.moved = true;

    const pixelX = point.x * canvas.width - drag.offsetX;
    const pixelY = point.y * canvas.height - drag.offsetY;
    drag.target.x = Math.max(0, Math.min(100, (pixelX - drag.slot.x) / drag.slot.width * 100));
    drag.target.y = Math.max(0, Math.min(100, (pixelY - drag.slot.y) / drag.slot.height * 100));
  }

  render();
});

function stopDrag(event, commitStroke = false) {
  if (drag?.type === "draw") {
    if (commitStroke && event) {
      const finalPoint = getCoords(event);
      const lastPoint = drag.target.points[drag.target.points.length - 1];
      if (!lastPoint || Math.hypot(finalPoint.x - lastPoint.x, finalPoint.y - lastPoint.y) > 0.1) {
        drag.target.points.push(finalPoint);
      }
    }
    if (drag.target.autoShape) {
      drag.target.shape = recognizeShape(drag.target);
    }
    render();
  } else if (drag?.type === "imageTransform") {
    render();
  }
  drag = null;
  canvas.style.cursor = activeTool === "image" ? "grab" : "default";
}

canvas.addEventListener("pointerup", event => stopDrag(event, true));
canvas.addEventListener("pointercancel", event => stopDrag(event, false));

function recognizeShape(stroke) {
  const points = (stroke.points || []).map(point => ({
    x: point.x * canvas.width / 100,
    y: point.y * canvas.height / 100
  }));
  if (points.length < 2) return null;

  const bounds = points.reduce((box, point) => ({
    left: Math.min(box.left, point.x),
    right: Math.max(box.right, point.x),
    top: Math.min(box.top, point.y),
    bottom: Math.max(box.bottom, point.y)
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const diagonal = Math.hypot(width, height);
  if (diagonal < 8) return null;

  let pathLength = 0;
  for (let i = 1; i < points.length; i++) {
    pathLength += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  const first = points[0];
  const last = points[points.length - 1];
  const endpointDistance = Math.hypot(last.x - first.x, last.y - first.y);

  // 짧고 곧은 선은 포인터 샘플이 적어도 인식합니다.
  if (points.length === 2) return { type: "line" };
  const lineLength = Math.max(endpointDistance, 1);
  const maxLineDeviation = points.reduce((max, point) => {
    const distance = Math.abs(
      (last.y - first.y) * point.x -
      (last.x - first.x) * point.y +
      last.x * first.y - last.y * first.x
    ) / lineLength;
    return Math.max(max, distance);
  }, 0);
  if (endpointDistance / Math.max(pathLength, 1) > 0.76 && maxLineDeviation < diagonal * 0.13) {
    return { type: "line" };
  }

  const closed = endpointDistance <= Math.max(20, diagonal * 0.28) && pathLength >= diagonal * 1.15;
  if (!closed) return null;

  const loop = endpointDistance <= diagonal * 0.28 ? points.slice(0, -1) : points;
  if (loop.length < 5) return null;

  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const radiusX = Math.max(width / 2, 1);
  const radiusY = Math.max(height / 2, 1);
  const ellipseError = loop.reduce((sum, point) => {
    const normalized = Math.hypot((point.x - centerX) / radiusX, (point.y - centerY) / radiusY);
    return sum + Math.abs(normalized - 1);
  }, 0) / loop.length;
  if (ellipseError < 0.16) return { type: "ellipse" };

  // 닫힌 선을 가장 먼 점에서 둘로 나누고 RDP로 단순화해 꼭짓점을 찾습니다.
  const count = loop.length;
  let farthestIndex = 1;
  let farthestDistance = 0;
  for (let i = 1; i < count; i++) {
    const distance = Math.hypot(loop[i].x - loop[0].x, loop[i].y - loop[0].y);
    if (distance > farthestDistance) {
      farthestDistance = distance;
      farthestIndex = i;
    }
  }

  const simplify = path => {
    if (path.length <= 2) return path;
    const firstPoint = path[0];
    const lastPoint = path[path.length - 1];
    const dx = lastPoint.x - firstPoint.x;
    const dy = lastPoint.y - firstPoint.y;
    const length = Math.hypot(dx, dy) || 1;
    let maximum = 0;
    let index = 0;
    for (let i = 1; i < path.length - 1; i++) {
      const point = path[i];
      const distance = Math.abs(dy * point.x - dx * point.y + lastPoint.x * firstPoint.y - lastPoint.y * firstPoint.x) / length;
      if (distance > maximum) {
        maximum = distance;
        index = i;
      }
    }
    if (maximum <= diagonal * 0.055 || index === 0) return [firstPoint, lastPoint];
    const leftPath = simplify(path.slice(0, index + 1));
    const rightPath = simplify(path.slice(index));
    return [...leftPath.slice(0, -1), ...rightPath];
  };

  const arcA = loop.slice(0, farthestIndex + 1);
  const arcB = [...loop.slice(farthestIndex), loop[0]];
  const corners = [
    ...simplify(arcA).slice(0, -1),
    ...simplify(arcB).slice(0, -1)
  ];

  if (corners.length === 3) return { type: "triangle" };
  if (corners.length === 4 || corners.length === 5) return { type: "rectangle" };
  return null;
}

// ======================================
// 16. SAVE / JSON / OUTPUT
// ======================================

$("btnSave").addEventListener("click", openTemplateModal);

$("createTemplateBtn").addEventListener("click", createTemplate);

$("closeModalBtn").addEventListener("click", closeTemplateModal);

$("templateModal").addEventListener("click", e => {
  if (e.target === $("templateModal")) {
    closeTemplateModal();
  }
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    closeTemplateModal();
  }
});

$("btnSaveJson")?.addEventListener("click", exportToJson);

$("jsonFileInput")?.addEventListener("change", e => {
  const file = e.target.files?.[0];

  if (file) {
    importFromJson(file);
  }

  e.target.value = "";
});

$("btnOutput").addEventListener("click", () => {
  render({ showControls: false });

  const format =
    $("outputFormat")?.value || "image/png";

  const ext =
    format === "image/jpeg"
      ? "jpg"
      : format === "image/webp"
        ? "webp"
        : "png";

  canvas.toBlob(
    blob => {
      render();
      if (!blob) {
        setStatus("파일 생성 실패", true);
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.download = `card-studio-${Date.now()}.${ext}`;

      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setStatus(
        `${ext.toUpperCase()} 파일 다운로드가 시작되었습니다.`
      );
    },
    format,
    format === "image/jpeg" || format === "image/webp"
      ? 0.9
      : undefined
  );
});

// ======================================
// 17. 사진 분할 레이아웃
// ======================================

const splitOverlay = $("splitOverlay");
const splitZoneBtns =
  document.querySelectorAll(".split-zone-btn");

const slotFileInput = $("slotFileInput");

let currentSlotIndex = 0;

function setLayout(layout) {
  if (state.splitLayout === layout) return;

  remember();

  state.splitLayout = layout;

  state.splitImages = Array(9).fill(null);
  state.splitImageTransforms = Array.from(
    { length: 9 },
    () => ({ x: 50, y: 50, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 })
  );
  selectedSplitSlotIndex = null;
  state.selectedSplitImageIndex = null;
  state.imageSelected = false;

  syncSplitLayoutUI();
  syncImageScaleControl();

  render();

  setStatus(`${layout}칸 사진 분할 레이아웃으로 변경했습니다.`);
}

function getSplitSlotAt(point) {
  const cols = state.splitLayout === 9 ? 3 : 2;
  const rows = state.splitLayout === 2 ? 1 : cols;
  const gap = state.splitLayout === 9 ? 6 : 10;
  const width = (canvas.width - gap * (cols - 1)) / cols;
  const height = (canvas.height - gap * (rows - 1)) / rows;
  const x = point.x * canvas.width / 100;
  const y = point.y * canvas.height / 100;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const slotX = col * (width + gap);
      const slotY = row * (height + gap);
      if (x >= slotX && x <= slotX + width && y >= slotY && y <= slotY + height) {
        return { index: row * cols + col, x: slotX, y: slotY, width, height };
      }
    }
  }
  return null;
}

// 사진 분할 레이아웃 화면 동기화
function syncSplitLayoutUI() {
  const layout = state.splitLayout || 1;

  splitOverlay.className = "split-overlay";

  if (layout === 2) {
    splitOverlay.classList.add("mode-2");
  }

  if (layout === 4) {
    splitOverlay.classList.add("mode-4");
  }
  if (layout === 9) {
    splitOverlay.classList.add("mode-9");
  }

  if (layout === 1) {
    splitOverlay.style.display = "none";
    uploadPlaceholder.style.display = state.image ? "none" : "flex";
  } else {
    splitOverlay.style.display = "grid";
    uploadPlaceholder.style.display = "none";
  }

  $("layout1Btn").style.background =
    layout === 1 ? "#bfdbfe" : "#e6efff";

  $("layout2Btn").style.background =
    layout === 2 ? "#bfdbfe" : "#e6efff";

  $("layout4Btn").style.background =
    layout === 4 ? "#bfdbfe" : "#e6efff";
  $("layout9Btn").style.background =
    layout === 9 ? "#bfdbfe" : "#e6efff";
  splitZoneBtns.forEach(btn => {
    btn.hidden = Number(btn.dataset.slot) >= (layout === 9 ? 9 : layout === 4 ? 4 : layout === 2 ? 2 : 0);
    btn.textContent = `＋ ${Number(btn.dataset.slot) + 1}번 칸 사진 추가`;
    btn.classList.toggle("selected", Number(btn.dataset.slot) === selectedSplitSlotIndex);
    btn.classList.toggle("filled", !!state.splitImages[Number(btn.dataset.slot)]);
  });
  state.imageEditing = activeTool === "image";
  splitOverlay.classList.toggle("canvas-editing", ["image", "draw", "sticker"].includes(activeTool));
  splitOverlay.classList.toggle("image-editing", activeTool === "image");
}

$("layout1Btn")?.addEventListener("click", () => setLayout(1));
$("layout2Btn")?.addEventListener("click", () => setLayout(2));
$("layout4Btn")?.addEventListener("click", () => setLayout(4));
$("layout9Btn")?.addEventListener("click", () => setLayout(9));

splitZoneBtns.forEach(btn => {
  btn.addEventListener("click", e => {
    e.stopPropagation();

    currentSlotIndex = Number(btn.dataset.slot);
    selectedSplitSlotIndex = currentSlotIndex;
    state.selectedSplitImageIndex = currentSlotIndex;
    syncSplitLayoutUI();
    syncImageScaleControl();
    slotFileInput.click();
  });
});

slotFileInput?.addEventListener("change", e => {
  const file = e.target.files?.[0];

  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    // ★ 이미지 로딩 성공 시점에 기록 (실패 시 Undo 누수 방지)
    remember();

    state.splitImages[currentSlotIndex] = img;
    state.splitImageTransforms[currentSlotIndex] = { x: 50, y: 50, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };
    selectedSplitSlotIndex = currentSlotIndex;
    state.selectedSplitImageIndex = currentSlotIndex;
    syncSplitLayoutUI();
    syncImageScaleControl();

    render();

    setStatus(
      `${currentSlotIndex + 1}번째 칸에 사진이 추가되었습니다.`
    );

    URL.revokeObjectURL(url);
  };

  img.onerror = () => {
    setStatus("이미지를 불러오지 못했습니다.", true);
    URL.revokeObjectURL(url);
  };

  img.src = url;
  e.target.value = "";
});

// ======================================
// 17-1. template.js 이벤트 수신
// ======================================

document.addEventListener("splitLayoutChanged", () => {
  selectedSplitSlotIndex = null;
  state.selectedSplitImageIndex = null;
  state.imageSelected = false;
  syncSplitLayoutUI();
  syncImageScaleControl();
});

document.addEventListener("requestRender", () => {
  render();
});

document.addEventListener("imageLoaded", syncImageScaleControl);

// 기기별 편집 결과 미리보기
const previewModal = $("devicePreviewModal");
const previewFrame = $("previewFrame");
const previewImage = $("previewImage");
const previewModeButtons = document.querySelectorAll("[data-preview]");
let previewObjectUrl = null;
let previewRequestId = 0;

function setPreviewMode(mode) {
  previewFrame.className = `preview-frame ${mode}`;
  previewModeButtons.forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.preview === mode));
  });

  const ratio = Math.min(1.91, Math.max(0.8, canvas.width / canvas.height));
  previewFrame.style.setProperty("--preview-ratio", `${ratio} / 1`);
}

async function updatePreviewImage() {
  const requestId = ++previewRequestId;
  render({ showControls: false });
  let blob;
  try {
    blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  } finally {
    render();
  }
  if (!blob || requestId !== previewRequestId) return;

  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(blob);
  previewImage.src = previewObjectUrl;
}

function closeDevicePreview() {
  previewModal.hidden = true;
  document.body.style.overflow = "";
  previewRequestId++;
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  previewImage.removeAttribute("src");
}

$("previewBtn").addEventListener("click", async () => {
  previewModal.hidden = false;
  document.body.style.overflow = "hidden";
  setPreviewMode("phone");
  try {
    await updatePreviewImage();
  } catch {
    setStatus("미리보기 이미지를 만들지 못했습니다.", true);
  }
});

$("closePreviewBtn").addEventListener("click", closeDevicePreview);
previewModal.addEventListener("click", event => {
  if (event.target === previewModal) closeDevicePreview();
});
previewModeButtons.forEach(button => {
  button.addEventListener("click", () => setPreviewMode(button.dataset.preview));
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !previewModal.hidden) closeDevicePreview();
});

// ======================================
// 18. 초기 실행
// ======================================

$("frameType").value = state.frameType || "none";
$("imageFit").value = state.imageFit || "cover";
updateFrameControls();
updateGradientControls();
syncImageScaleControl();

renderStickerPanel();
restoreCustomFonts();

window.addEventListener("resize", updateCanvasSize);

updateCanvasSize();
