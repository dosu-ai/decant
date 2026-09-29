export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export interface LinkTarget {
  href: string;
  target?: string | null;
  download?: boolean;
}

/**
 * Only a plain primary-button click on a same-tab, same-origin path may be
 * routed in-app. Everything else (new tab, save-as, external URL) must keep
 * the browser's native behaviour.
 */
export function shouldInterceptLinkClick(click: LinkClick, link: LinkTarget): boolean {
  if (click.defaultPrevented || click.button !== 0) {
    return false;
  }
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) {
    return false;
  }
  if (link.download === true) {
    return false;
  }
  if (link.target != null && link.target !== "" && link.target !== "_self") {
    return false;
  }
  return link.href.startsWith("/") && !link.href.startsWith("//");
}
