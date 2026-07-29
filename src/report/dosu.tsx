import type { ReactElement } from "react";
import { dosuLink } from "../ui/dosu-links.ts";

export type ReportDosuPlacement = "report_footer" | "report_cta";

export function reportDosuLink(placement: ReportDosuPlacement): string {
  return dosuLink(placement);
}

export function DosuOptimizedMark(): ReactElement {
  return (
    <a
      aria-label="Optimized with Dosu"
      className="dosu-optimized"
      href={reportDosuLink("report_footer")}
      rel="noopener noreferrer"
      target="_blank"
    >
      <svg
        aria-hidden="true"
        className="dosu-logo"
        fill="none"
        viewBox="0 0 23.7748 24.5985"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M1.39 3.42 4.86 1.72v18.35l-3.47 3.2V3.42Z" fill="#b4bb91" />
        <path d="m5 20.23 11.39-.11-2.07 2.7L8 23.9l-6.35-.32L5 20.23Z" fill="#778561" />
        <path
          d="M4.79.9.91 3.4v19.74c0 .33.39.5.63.28l3.84-3.57"
          stroke="#000"
          strokeLinecap="round"
          strokeWidth="1.79"
        />
        <path
          d="M13.23 1.98a8.57 8.57 0 0 1 0 17.14H6.64V1.98h6.59Z"
          fill="#e6eae2"
          stroke="#000"
          strokeWidth="1.98"
        />
        <path
          d="M19.11 9.89s-.88 3.75-4.87 3.75-5.25-3.38-5.25-3.75"
          stroke="#000"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.14"
        />
        <path
          d="M.01 23.67s8.12.1 9.6.06c2.79-.07 4.59-.36 6.33-1.87 1.47-1.28 4.9-5.38 4.9-5.38"
          stroke="#000"
          strokeWidth="1.72"
        />
      </svg>
      <span>Optimized</span>
    </a>
  );
}
