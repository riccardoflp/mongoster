// The stripe of a connection's or a collection's color at the top of a tab's content: `--conn-color` set to the
// color as CSS (a preset's theme variable, or a custom `#rrggbb`), and `data-color` for the rules that draw it.
import { cssColorOf, readColor } from '../shared/colors';

export function paintStripe(element: HTMLElement, color: string | undefined): void {
  const c = color ? readColor(color) : undefined;
  if (c) {
    element.dataset.color = c;
    element.style.setProperty('--conn-color', cssColorOf(c));
  } else {
    delete element.dataset.color;
    element.style.removeProperty('--conn-color');
  }
}
