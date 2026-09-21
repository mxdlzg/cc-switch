import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 弹窗外壳的两条不变式（都是真实踩过的坑，之前没有任何测试钉住）：
 *
 * 1. **必须有可见的关闭控件**。fork 的 `DialogContent` 从来没画过叉号，鼠标用户只能
 *    找底部按钮——而有的弹窗底部只有「确定」。
 * 2. **正文必须落在一个会滚的容器里，外壳必须裁掉溢出**。外壳是 `flex-col` +
 *    `max-h-[90vh]`；正文若写成普通 `<div>`，内容一长就画到弹窗边框外面，外层又没有
 *    任何滚动容器，表现就是「内容被截了，滚轮也滚不动」。
 */

const shell = (ui: ReactNode) => (
  <Dialog open>
    <DialogContent>{ui}</DialogContent>
  </Dialog>
);

const contentEl = () => screen.getByRole("dialog");

describe("DialogContent 关闭控件", () => {
  it("renders a built-in close button by default", () => {
    render(shell(<DialogTitle>标题</DialogTitle>));
    const close = contentEl().querySelector("svg.lucide-x")?.closest("button");
    expect(close).not.toBeNull();
    // 无障碍名称不能缺：只有一个图标按钮时，读屏软件念不出"关闭"就没法用
    expect(close?.getAttribute("aria-label")).toBeTruthy();
  });

  it("opts out for dialogs that bring their own close affordance", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(contentEl().querySelector("svg.lucide-x")).toBeNull();
  });

  it("stays out of the fullscreen variant (it has its own back button)", () => {
    render(
      <Dialog open>
        <DialogContent variant="fullscreen">
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(contentEl().querySelector("svg.lucide-x")).toBeNull();
  });
});

describe("DialogContent 溢出", () => {
  it("clips its own overflow instead of painting past the frame", () => {
    render(shell(<DialogTitle>标题</DialogTitle>));
    // 缺了 overflow-hidden，长正文会画到弹窗圆角外（用户看到的"超出屏幕"）
    expect(contentEl()).toHaveClass("overflow-hidden");
  });

  it("keeps the header clear of the close button", () => {
    render(
      shell(
        <DialogHeader>
          <DialogTitle>标题</DialogTitle>
        </DialogHeader>,
      ),
    );
    // 让位的是 DialogHeader 这一层（叉号是 DialogContent 的直接子元素，绝对定位在
    // 右上角）；pr-12 写成 pr-* 而不是 px-*，调用处才能用 px-4 整组覆盖。
    const header = screen.getByRole("heading", { name: "标题" }).parentElement;
    expect(header).toHaveClass("pr-12");
  });
});

describe("DialogBody", () => {
  it("is the scroll container", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>标题</DialogTitle>
          </DialogHeader>
          <DialogBody data-testid="body">正文</DialogBody>
        </DialogContent>
      </Dialog>,
    );
    // 三条缺一不可：flex 列里 `min-h-0` 才允许收缩到内容高度以下，`flex-1` 才吃满
    // 剩余高度，`overflow-y-auto` 才真的产生滚动
    const body = screen.getByTestId("body");
    expect(body).toHaveClass("min-h-0");
    expect(body).toHaveClass("flex-1");
    expect(body).toHaveClass("overflow-y-auto");
  });

  it("lets the caller override the padding without leaving a stray class", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogBody data-testid="body" className="p-0">
            正文
          </DialogBody>
        </DialogContent>
      </Dialog>,
    );
    // twMerge 必须把默认的 px-6/py-5 顶掉，否则 p-0 只是"加在末尾"而实际不生效
    const body = screen.getByTestId("body");
    expect(body).toHaveClass("p-0");
    expect(body.className).not.toContain("px-6");
  });
});
