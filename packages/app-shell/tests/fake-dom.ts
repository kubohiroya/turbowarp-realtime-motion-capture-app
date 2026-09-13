type Listener = (event: unknown) => void;

export interface FakeElement {
  tagName: string;
  children: FakeElement[];
  parentNode: FakeElement | null;
  style: Record<string, string>;
  attributes: Map<string, string>;
  dataset: Record<string, string>;
  textContent: string;
  type: string;
  hidden: boolean;
  disabled: boolean;
  src: string;
  alt: string;
  value: number;
  max: number;
  removed: boolean;
  appendChild(child: FakeElement): FakeElement;
  remove(): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(name: string, listener: Listener): void;
  removeEventListener(name: string, listener: Listener): void;
  click(): void;
}

/** A DOM stand-in that satisfies the app-shell element contract without a browser environment. */
export function fakeElement(tagName: string): FakeElement {
  const children: FakeElement[] = [];
  const listeners = new Map<string, Listener[]>();
  return {
    tagName,
    children,
    parentNode: null,
    style: {},
    attributes: new Map<string, string>(),
    dataset: {},
    textContent: '',
    type: '',
    hidden: false,
    disabled: false,
    src: '',
    alt: '',
    value: 0,
    max: 0,
    removed: false,
    appendChild(child: FakeElement) {
      children.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {
      const parent = this.parentNode;
      if (parent !== null) {
        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);
        this.parentNode = null;
      }
      this.removed = true;
    },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
    addEventListener(name: string, listener: Listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    removeEventListener(name: string, listener: Listener) {
      listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener));
    },
    click() {
      for (const listener of listeners.get('click') ?? []) {
        listener({preventDefault() {}, stopPropagation() {}});
      }
    }
  };
}

export function fakeDocument(): Document {
  return {
    body: fakeElement('body'),
    createElement: (tagName: string) => fakeElement(tagName)
  } as unknown as Document;
}

export function findByText(element: FakeElement, text: string): FakeElement[] {
  const found = element.textContent === text ? [element] : [];
  for (const child of element.children) found.push(...findByText(child, text));
  return found;
}
