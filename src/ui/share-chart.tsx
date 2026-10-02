import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dosuDecantUrl from "./assets/dosu-decant.png";
import dosuOfficialUrl from "./assets/dosu-official.svg";
import {
  type AnalyticsChartMetric,
  type AnalyticsChartVariant,
  prepareAnalyticsChartState,
} from "./chart-state.ts";
import { buildChartOption } from "./charts.tsx";
import { PrivacyReviewLists } from "./common.tsx";
import { useDialogFocusTrap } from "./focus.ts";
import { errorMessage } from "./format.ts";
import { Icon } from "./icons.tsx";
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_SCALE,
  SHARE_CARD_WIDTH,
  SHARE_EXCLUDED_FIELDS,
  SHARE_INCLUDED_FIELDS,
  type ShareCardCopyInput,
  shareCardAltText,
  shareCardButtonLabel,
  shareCardCaption,
  shareCardFilename,
  shareCardQualifier,
  shareCardTakeaway,
  shareCardTitle,
} from "./share-card.ts";

export function ShareChartButton({
  disabled = false,
  input,
  metric,
  variant,
}: {
  disabled?: boolean;
  input: ShareCardCopyInput;
  metric: AnalyticsChartMetric;
  variant: AnalyticsChartVariant;
}) {
  const [open, setOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [png, setPng] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const renderVersionRef = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeShareReview = useCallback(() => setOpen(false), []);
  const title = shareCardTitle(input.kind);
  const caption = shareCardCaption(input);
  const altText = shareCardAltText(input);
  const filename = shareCardFilename(input.kind, input.start, input.end);

  const setPreview = useCallback((blob: Blob | null) => {
    if (previewUrlRef.current != null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const nextUrl = blob == null ? null : URL.createObjectURL(blob);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
    setPng(blob);
  }, []);

  const renderPreview = useCallback(async () => {
    const version = renderVersionRef.current + 1;
    renderVersionRef.current = version;
    setBusy(true);
    setStatus(null);
    try {
      const blob = await renderShareCardPng(input, metric, variant);
      if (renderVersionRef.current === version) {
        setPreview(blob);
      }
    } catch (error) {
      if (renderVersionRef.current === version) {
        setStatus(`Unable to render image: ${errorMessage(error)}`);
        setPreview(null);
      }
    } finally {
      if (renderVersionRef.current === version) {
        setBusy(false);
      }
    }
  }, [input, metric, setPreview, variant]);

  useEffect(
    () => () => {
      renderVersionRef.current += 1;
      if (previewUrlRef.current != null) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

  useDialogFocusTrap(open, dialogRef, closeShareReview);

  const copyText = async (value: string, success: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(success);
    } catch (error) {
      setStatus(`Clipboard unavailable: ${errorMessage(error)}`);
    }
  };

  const copyImage = async () => {
    if (png == null || typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
      setStatus("Image copying is unavailable in this browser. Download the PNG instead.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      setStatus("Image copied.");
    } catch (error) {
      setStatus(`Image copy failed: ${errorMessage(error)}`);
    }
  };

  const download = () => {
    if (previewUrl == null) {
      return;
    }
    const anchor = document.createElement("a");
    anchor.download = filename;
    anchor.href = previewUrl;
    anchor.click();
    setStatus(`Downloaded ${filename}.`);
  };

  const nativeShare = async () => {
    if (png == null || navigator.share == null) {
      setStatus("The native share sheet is unavailable in this browser.");
      return;
    }
    const file = new File([png], filename, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] }) === false) {
      setStatus("This browser cannot share PNG files. Download the image instead.");
      return;
    }
    try {
      await navigator.share({ files: [file], title, text: caption });
      setStatus("Shared from your device.");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setStatus("Share canceled.");
      } else {
        setStatus(`Share failed: ${errorMessage(error)}`);
      }
    }
  };

  return (
    <>
      <button
        aria-label={shareCardButtonLabel(input.kind)}
        className="chart-share-button"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          void renderPreview();
        }}
        type="button"
      >
        <Icon name="share" />
        Share
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismissal supplements Escape and the explicit close button.
            <div
              className="share-review-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeShareReview();
                }
              }}
            >
              <section
                aria-labelledby={`share-title-${input.kind}`}
                aria-modal="true"
                className="share-review-sheet"
                ref={dialogRef}
                role="dialog"
                tabIndex={-1}
              >
                <header>
                  <div>
                    <span>Local, aggregate-only export</span>
                    <h2 id={`share-title-${input.kind}`}>Review {title}</h2>
                  </div>
                  <button
                    aria-label="Close share review"
                    className="icon-button"
                    onClick={closeShareReview}
                    type="button"
                  >
                    <Icon name="x" />
                  </button>
                </header>
                <div className="share-review-body">
                  <div className="share-preview">
                    {busy ? (
                      <div className="share-preview-loading">Rendering locally…</div>
                    ) : previewUrl == null ? (
                      <div className="share-preview-loading">Preview unavailable</div>
                    ) : (
                      <img alt={altText} src={previewUrl} />
                    )}
                    <p className="share-export-size">2× high-density PNG · 2400 × 1260</p>
                  </div>
                  <PrivacyReviewLists
                    className="share-privacy-review"
                    excluded={SHARE_EXCLUDED_FIELDS}
                    excludedLabel="Always excluded"
                    included={SHARE_INCLUDED_FIELDS}
                    includedLabel="Included"
                  />
                  <div className="share-copy-review">
                    <div>
                      <strong>Caption</strong>
                      <p>{caption}</p>
                    </div>
                    <div>
                      <strong>Alt text</strong>
                      <p>{altText}</p>
                    </div>
                  </div>
                </div>
                <footer>
                  <div className="share-actions">
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={() => void copyImage()}
                      type="button"
                    >
                      <Icon name="copy" />
                      Copy image
                    </button>
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={download}
                      type="button"
                    >
                      <Icon name="download" />
                      Download PNG
                    </button>
                    <button
                      className="secondary-button"
                      disabled={png == null || busy}
                      onClick={() => void nativeShare()}
                      type="button"
                    >
                      <Icon name="share" />
                      Share…
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyText(caption, "Caption copied.")}
                      type="button"
                    >
                      Copy caption
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void copyText(altText, "Alt text copied.")}
                      type="button"
                    >
                      Copy alt text
                    </button>
                  </div>
                  <p aria-live="polite">{status ?? "Nothing leaves this machine until you act."}</p>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export async function renderShareCardPng(
  input: ShareCardCopyInput,
  metric: AnalyticsChartMetric,
  variant: AnalyticsChartVariant,
): Promise<Blob> {
  const scale = SHARE_CARD_SCALE;
  const chartNode = document.createElement("div");
  chartNode.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1080px;height:310px;pointer-events:none";
  document.body.append(chartNode);
  const echarts = await import("./chart-runtime.ts");
  const chart = echarts.init(chartNode, null, {
    renderer: "canvas",
    width: 1080,
    height: 310,
  });
  let chartUrl: string;
  try {
    const state = prepareAnalyticsChartState({
      labels: input.labels,
      metric,
      values: input.values,
      variant,
    });
    chart.setOption(
      {
        ...buildChartOption(state),
        animation: false,
        backgroundColor: "#11151f",
      },
      true,
    );
    chartUrl = chart.getDataURL({
      backgroundColor: "#11151f",
      pixelRatio: Math.max(1, scale),
      type: "png",
    });
  } finally {
    chart.dispose();
    chartNode.remove();
  }

  const [chartImage, decantImage, dosuImage] = await Promise.all([
    loadCanvasImage(chartUrl),
    loadCanvasImage(dosuDecantUrl),
    loadCanvasImage(dosuOfficialUrl),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = SHARE_CARD_WIDTH * scale;
  canvas.height = SHARE_CARD_HEIGHT * scale;
  const context = canvas.getContext("2d");
  if (context == null) {
    throw new Error("2D canvas is unavailable");
  }
  context.scale(scale, scale);
  context.fillStyle = "#0b0e14";
  context.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT);
  context.fillStyle = "#11151f";
  context.fillRect(42, 34, SHARE_CARD_WIDTH - 84, SHARE_CARD_HEIGHT - 68);

  context.drawImage(decantImage, 68, 58, 34, 34);
  context.fillStyle = "#e7eaf0";
  context.font = "650 22px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText("Decant", 114, 83);
  context.fillStyle = "#9aa6b8";
  context.font = "500 17px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "right";
  context.fillText(shareCardRange(input), SHARE_CARD_WIDTH - 68, 81);
  context.textAlign = "left";

  context.fillStyle = "#e7eaf0";
  context.font = "650 36px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardTitle(input.kind), 68, 142);
  context.fillStyle = "#9aa6b8";
  context.font = "500 22px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardTakeaway(input), 68, 178);
  context.drawImage(chartImage, 68, 204, SHARE_CARD_WIDTH - 136, 304);

  context.fillStyle = "#6b7689";
  context.font = "500 16px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText(shareCardQualifier(input.kind), 68, 557);
  context.drawImage(dosuImage, SHARE_CARD_WIDTH - 244, 537, 24, 25);
  context.fillStyle = "#9aa6b8";
  context.font = "600 16px Inter, ui-sans-serif, system-ui, sans-serif";
  context.fillText("Decant · by Dosu", SHARE_CARD_WIDTH - 210, 557);

  return await canvasPngBlob(canvas);
}

export function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load local image asset: ${src}`));
    image.src = src;
  });
}

export function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob == null) {
        reject(new Error("PNG encoding failed"));
      } else {
        resolve(blob);
      }
    }, "image/png");
  });
}

export function shareRange(labels: string[]): { start: string; end: string } {
  return {
    start: labels[0] ?? "All time",
    end: labels.at(-1) ?? "All time",
  };
}

export function shareCardRange(input: ShareCardCopyInput): string {
  const range = input.start === input.end ? input.start : `${input.start}–${input.end}`;
  return `${range} · ${input.timezone}`;
}

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
}
