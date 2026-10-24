import React, { act } from "react";
import { createRoot } from "react-dom/client";

// Test-only harness: mounts a hook in a host component and lets a test change
// its props and read its latest return value. Not exported from the package.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

export function mountHook<P, V>(use: (props: P) => V, initial: P) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let props = initial;
  let value = undefined as V;
  const Host = () => {
    value = use(props);
    return null;
  };
  const render = () => act(() => root.render(React.createElement(Host)));
  render();
  return {
    get value() {
      return value;
    },
    rerender(next: P) {
      props = next;
      render();
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}
