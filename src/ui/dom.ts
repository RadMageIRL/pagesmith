type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

/**
 * Tiny element builder. Text only ever goes in through textContent / text nodes, never innerHTML,
 * so filenames and other untrusted strings can't inject markup.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) node.addEventListener(type, handler as EventListener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
}

export function button(label: string, onClick: () => void, opts: { class?: string; title?: string; disabled?: boolean; attrs?: Props['attrs'] } = {}): HTMLButtonElement {
  const b = h('button', { class: opts.class ?? 'button', text: label, title: opts.title, attrs: { type: 'button', ...opts.attrs }, on: { click: onClick } });
  b.disabled = !!opts.disabled;
  return b;
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
