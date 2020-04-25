import { html, htext } from './html';

function translateKey(ev: KeyboardEvent): string {
  switch (ev.key) {
    case 'Alt':
    case 'Control':
    case 'Shift':
    case 'Unidentified':
      return '';
  }
  // Avoid browser tab switch keys:
  if (ev.key >= '0' && ev.key <= '9') return '';

  let name = '';
  if (ev.altKey) name += 'M-';
  if (ev.ctrlKey) name += 'C-';
  name += ev.key;
  return name;
}

export interface CompleteRequest {
  input: string;
  pos: number;
}

export interface CompleteResponse {
  completions: string[];
  pos: number;
}

class CompletePopup {
  dom = html('div', { className: 'popup', style: { overflow: 'hidden' } });
  oncommit: (text: string, pos: number) => void = () => {};
  textSize!: { width: number; height: number };

  constructor(readonly req: CompleteRequest, readonly resp: CompleteResponse) {}

  show(parent: HTMLElement) {
    this.textSize = this.measure(
      parent,
      this.req.input.substring(0, this.resp.pos) + '\u200b'
    );

    this.dom.innerText = this.resp.completions.join('\n');
    parent.appendChild(this.dom);
    this.position();
  }

  /** Measures the size of the given text as if it were contained in the parent. */
  private measure(
    parent: HTMLElement,
    text: string
  ): { width: number; height: number } {
    const measure = html(
      'div',
      {
        style: {
          position: 'absolute',
          visibility: 'hidden',
          whiteSpace: 'pre',
        },
      },
      htext(text)
    );
    parent.appendChild(measure);
    const { width, height } = getComputedStyle(measure);
    parent.removeChild(measure);
    return { width: parseFloat(width), height: parseFloat(height) };
  }

  /** Positions this.dom. */
  private position() {
    const { x, y } = (this.dom.parentNode as HTMLElement).getClientRects()[0];
    const popupHeight = this.dom.offsetHeight;

    // Popup may not fit.  Options in order of preference:
    // 1. Pop up below, if it fits.
    // 2. Pop up above, if it fits.
    // 3. Pop up in whichever side has more space, but truncated

    const spaceAbove = y;
    const spaceBelow = window.innerHeight - (y + this.textSize.height);
    if (spaceBelow >= popupHeight) {
      this.dom.style.top = `${y + this.textSize.height}px`;
      this.dom.style.bottom = '';
    } else if (spaceAbove >= popupHeight) {
      this.dom.style.top = '';
      this.dom.style.bottom = `${window.innerHeight - y}px`;
    } else {
      if (spaceBelow >= spaceAbove) {
        this.dom.style.top = `${y + this.textSize.height}px`;
        this.dom.style.bottom = '10px';
      } else {
        this.dom.style.top = '10px';
        this.dom.style.bottom = `${window.innerHeight - y}px`;
      }
    }

    const inputPaddingLeft = 2;
    const popupPaddingLeft = 4;
    this.dom.style.left =
      x + inputPaddingLeft - popupPaddingLeft + this.textSize.width + 'px';
  }

  hide() {
    this.dom.parentNode!.removeChild(this.dom);
  }

  /** @param key The key name as produced by translateKey(). */
  handleKey(key: string): boolean {
    switch (key) {
      case 'Tab':
        // Don't allow additional popups.
        return true;
      case 'Enter':
        this.oncommit(this.resp.completions[0], this.resp.pos);
        return true;
      case 'Escape':
        this.oncommit('', this.resp.pos);
        return true;
    }
    return false;
  }
}

/** Returns the length of the longest prefix shared by all input strings. */
function longestSharedPrefixLength(strs: string[]): number {
  for (let len = 0; ; len++) {
    let c = -1;
    for (const str of strs) {
      if (len === str.length) return len;
      if (c === -1) c = str.charCodeAt(len);
      else if (str.charCodeAt(len) !== c) return len;
    }
  }
}

export function backwardWordBoundary(text: string, pos: number): number {
  for (; pos > 0; pos--) {
    if (text.charAt(pos - 1) !== ' ') break;
  }
  for (; pos > 0; pos--) {
    if (text.charAt(pos - 1) === ' ') break;
  }

  return pos;
}

export class ReadLine {
  dom = html('div', { className: 'readline' });
  prompt = html('div', { className: 'prompt' });
  inputBox = html('div', { className: 'input-box' });
  input = html('input', {
    spellcheck: false,
  }) as HTMLInputElement;
  oncommit = (_: string) => {};

  oncomplete: (
    req: CompleteRequest
  ) => Promise<CompleteResponse> = async () => {
    throw 'notimpl';
  };

  pendingComplete: Promise<CompleteResponse> | undefined;
  popup: CompletePopup | undefined;

  /**
   * The selection span at time of last blur.
   * This is restored on focus, to defeat the browser behavior of
   * select all on focus.
   */
  selection: [number, number] = [0, 0];

  constructor() {
    this.prompt.innerText = '> ';
    this.dom.appendChild(this.prompt);

    this.inputBox.appendChild(this.input);
    this.dom.appendChild(this.inputBox);

    this.input.onkeydown = (ev) => {
      const key = translateKey(ev);
      if (!key) return;
      if (this.handleKey(key)) ev.preventDefault();
    };
    this.input.onkeypress = (ev) => {
      const key = ev.key;
      if (!key) return;
      if (this.handleKey(key)) ev.preventDefault();
    };

    // Catch focus/blur events, per docs on this.selection.
    this.input.addEventListener('blur', () => {
      this.selection = [this.input.selectionStart!, this.input.selectionEnd!];
      this.pendingComplete = undefined;
      this.hidePopup();
    });
    this.input.addEventListener('focus', () => {
      [this.input.selectionStart, this.input.selectionEnd] = this.selection;
    });
  }

  setPrompt(text: string) {
    this.prompt.innerText = `${text}$ `;
  }

  focus() {
    this.input.focus();
  }

  hidePopup() {
    if (!this.popup) return;
    this.popup.hide();
    this.popup = undefined;
  }

  /** @param key The key name as produced by translateKey(). */
  handleKey(key: string): boolean {
    if (this.popup && this.popup.handleKey(key)) return true;
    if (this.pendingComplete) this.pendingComplete = undefined;
    this.hidePopup();
    switch (key) {
      case 'Delete': // At least on ChromeOS, this is M-Backspace.
      case 'M-Backspace': {
        // backward-kill-word

        const pos = this.input.selectionStart || 0;
        const start = backwardWordBoundary(this.input.value, pos);
        this.input.value =
          this.input.value.substring(0, start) +
          this.input.value.substring(pos);
        break;
      }
      case 'Enter':
        this.oncommit(this.input.value);
        break;
      case 'Tab':
        const pos = this.input.selectionStart || 0;
        const req: CompleteRequest = { input: this.input.value, pos };
        const pending = (this.pendingComplete = this.oncomplete(req));
        pending.then((resp) => {
          if (pending !== this.pendingComplete) return;
          this.pendingComplete = undefined;
          if (resp.completions.length === 0) return;
          const len = longestSharedPrefixLength(resp.completions);
          if (len > 0) {
            this.applyCompletion(
              resp.completions[0].substring(0, len),
              resp.pos
            );
          }
          // If there was only one completion, it's already been applied, so
          // there is nothing else to do.
          if (resp.completions.length > 1) {
            // Show a popup for the completions.
            this.popup = new CompletePopup(req, resp);
            this.popup.show(this.inputBox);
            this.popup.oncommit = (text: string, pos: number) => {
              this.applyCompletion(text, pos);
              this.hidePopup();
            };
          }
        });
        break;
      case 'C-a':
        this.input.selectionStart = this.input.selectionEnd = 0;
        break;
      case 'C-b':
        this.input.selectionStart = this.input.selectionEnd =
          this.input.selectionStart! - 1;
        break;
      case 'C-e':
        const len = this.input.value.length;
        this.input.selectionStart = this.input.selectionEnd = len;
        break;
      case 'C-f':
        this.input.selectionStart = this.input.selectionEnd =
          this.input.selectionStart! + 1;
        break;
      case 'C-k':
        this.input.value = this.input.value.substr(
          0,
          this.input.selectionStart!
        );
        break;
      case 'C-n':
      case 'C-p':
        // TODO: implement history.  Swallow for now.
        break;
      case 'C-u':
        this.input.value = this.input.value.substr(this.input.selectionStart!);
        break;
      case 'C-x': // browser: cut
      case 'C-c': // browser: copy
      case 'C-v': // browser: paste
      case 'C-J': // browser: inspector
      case 'C-l': // browser: location
      case 'C-R': // browser: reload
        // Allow default handling.
        return false;
      default:
        console.log(key);
        return false;
    }
    return true;
  }

  applyCompletion(text: string, pos: number) {
    // The completion for a partial input may include some of that
    // partial input.  Elide any text from the completion that already
    // exists in the input at that same position.
    let overlap = 0;
    while (
      pos + overlap < this.input.value.length &&
      this.input.value[pos + overlap] === text[overlap]
    ) {
      overlap++;
    }
    this.input.value =
      this.input.value.substring(0, pos) +
      text +
      this.input.value.substring(pos + overlap);
  }
}
