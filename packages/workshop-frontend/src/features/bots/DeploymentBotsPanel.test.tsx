// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { RpcStub } from "capnweb";
import type { AdminApi, BotDefinition } from "@gadgets/workshop-shared/api";
import { DeploymentBotsPanel } from "./DeploymentBotsPanel";

// The panel's editor is the real BotEditorDialog, so Kumo's Dialog/Checkbox/Select are swapped
// for native controls the same way its own test file does.
vi.mock("@cloudflare/kumo", () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactNode }) => <>{render({})}</>,
    },
  )
  const Checkbox = ({ label, checked, disabled, onCheckedChange }: {
    label: ReactNode; checked?: boolean; disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onClick={() => { if (!disabled) onCheckedChange?.(checked !== true) }}
      />
      {label}
    </label>
  )
  const Select = ({ label, value, onValueChange, children }: {
    label?: ReactNode; value: string | null;
    onValueChange?: (value: string | null) => void; children: ReactNode
  }) => (
    <label>
      {label}
      <select value={value ?? undefined} onChange={(event) => onValueChange?.(event.target.value)}>
        {children}
      </select>
    </label>
  )
  Select.Option = ({ value, children }: { value: string | null; children: ReactNode }) => (
    <option value={value ?? undefined}>{children}</option>
  )
  return {
    Dialog,
    Checkbox,
    Select,
    useKumoToastManager: () => ({ add: () => {} }),
  };
});

vi.mock("@phosphor-icons/react", () => ({
  PencilSimple: () => <span>x</span>,
  Plus: () => <span>x</span>,
  Trash: () => <span>x</span>,
  X: () => <span>x</span>,
}));

// A stable api object: the panel's load effect keys on its identity, so a fresh object each
// render would loop the effect forever.
const authenticatedApi = {
  listModels: () => Promise.resolve([]),
  listBotSkills: () => Promise.resolve([]),
};

vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi }),
}));

vi.mock("../../components/DeleteConfirmationDialog", () => ({
  default: () => <div />,
}));

vi.mock("../../components/WorkshopControls", () => ({
  WorkshopInput: (props: Record<string, unknown> & { value?: string }) => (
    <input type="text" {...props} />
  ),
  WorkshopInputArea: (props: Record<string, unknown> & { value?: string }) => (
    <textarea {...props} />
  ),
  WorkshopButton: ({ children, disabled, onClick, type }: {
    children: ReactNode; disabled?: boolean; onClick?: () => void; type?: "submit" | "button"
  }) => (
    <button type={type ?? "button"} disabled={disabled} onClick={onClick}>{children}</button>
  ),
  WorkshopIconButton: ({ children, disabled, onClick }: {
    children: ReactNode; disabled?: boolean; onClick?: () => void
  }) => <button type="button" disabled={disabled} onClick={onClick}>{children}</button>,
}));

vi.mock("../../rpcErrors", () => ({
  rpcFailureDescription: () => "failed",
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

// A minimal stub: the panel only calls the list in these tests.
const admin = {
  listDeploymentBots: () => Promise.resolve([] as (BotDefinition & { id: string })[]),
} as unknown as RpcStub<AdminApi>;

async function renderPanel(): Promise<{ idInput: () => HTMLInputElement; configureButton: () => HTMLButtonElement }> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<DeploymentBotsPanel admin={admin} />));
  await act(async () => {});
  const add = [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Add deployment bot"))!;
  act(() => add.click());
  return {
    idInput: () => container!.querySelector<HTMLInputElement>('input[placeholder="research-assistant"]')!,
    configureButton: () =>
      [...container!.querySelectorAll("button")].find((b) => b.textContent?.includes("Configure"))!,
  };
}

// React's controlled inputs swallow programmatic value writes; route through the prototype setter.
function setId(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  descriptor.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("DeploymentBotsPanel", () => {
  it("associates the slug error with the id input through aria-describedby", async () => {
    const view = await renderPanel();
    // Empty id: the hint is what describes the input.
    expect(view.idInput().getAttribute("aria-describedby")).toBe("deployment-bot-id-hint");
    act(() => setId(view.idInput(), "Bad Slug!"));
    const input = view.idInput();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("deployment-bot-id-error");
    const error = container!.querySelector("#deployment-bot-id-error")!;
    expect(error.textContent).toContain("Lowercase letters");
  });

  it("keeps Configure clickable on an invalid id, but only opens the editor for a valid one", async () => {
    const view = await renderPanel();
    act(() => setId(view.idInput(), "not a slug"));
    expect(view.configureButton().disabled).toBe(false);
    act(() => view.configureButton().click());
    expect(container!.querySelector('input[placeholder="research-assistant"]')).not.toBeNull(); // still in the add flow

    act(() => setId(view.idInput(), "research-assistant"));
    act(() => view.configureButton().click());
    // The editor opened; the add form stays but is locked while configuring.
    expect(container!.querySelector<HTMLInputElement>('input[placeholder="research-assistant"]')!.disabled).toBe(true);
    expect(container!.textContent).toContain("New deployment bot");
  });
});
