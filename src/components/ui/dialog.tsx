import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
    zIndex?: "base" | "nested" | "alert" | "top";
  }
>(({ className, zIndex = "base", ...props }, ref) => {
  const zIndexMap = {
    base: "z-40",
    nested: "z-50",
    alert: "z-[60]",
    top: "z-[110]",
  };

  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        zIndexMap[zIndex],
        className,
      )}
      {...props}
    />
  );
});
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    zIndex?: "base" | "nested" | "alert" | "top";
    variant?: "default" | "fullscreen";
    overlayClassName?: string;
    /**
     * 关掉内置叉号。只给**自带**关闭/返回按钮的弹窗用（全屏编辑弹窗、目录抽屉），
     * 否则会出现两个叠在一起的关闭控件。
     */
    showCloseButton?: boolean;
    /** 叉号的无障碍名称；默认 `common.close`，调用处需要别的措辞时再覆盖。 */
    closeLabel?: string;
  }
>(
  (
    {
      className,
      children,
      zIndex = "base",
      variant = "default",
      overlayClassName,
      showCloseButton = true,
      closeLabel,
      ...props
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const zIndexMap = {
      base: "z-40",
      nested: "z-50",
      alert: "z-[60]",
      top: "z-[110]",
    };

    const variantClass = {
      // `overflow-hidden` 是必需的：本组件是 `flex-col` + `max-h-[90vh]`，正文由调用
      // 处提供（见 `DialogBody`）。没有它，正文一长就**画到弹窗边框外面**，而外层没有
      // 任何 overflow-auto —— 用户看到的就是"内容被截了，又滚不动"。
      default:
        "fixed left-1/2 top-1/2 flex flex-col overflow-hidden w-full max-w-lg max-h-[90vh] translate-x-[-50%] translate-y-[-50%] border border-border-default bg-background text-foreground shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
      fullscreen:
        "fixed inset-0 flex flex-col w-screen h-screen translate-x-0 translate-y-0 bg-background text-foreground p-0 sm:rounded-none shadow-none",
    }[variant];

    return (
      <DialogPortal>
        <DialogOverlay zIndex={zIndex} className={overlayClassName} />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(variantClass, zIndexMap[zIndex], className)}
          onInteractOutside={(e) => {
            // 防止点击遮罩层关闭对话框
            e.preventDefault();
          }}
          {...props}
        >
          {children}
          {/* Escape 关闭 Radix 本来就带（没被 onInteractOutside 影响），但缺一个可见
              控件时鼠标用户只能找底部按钮——有的弹窗底部只有「确定」。全屏弹窗自带返回
              按钮，所以只在 default 变体里画。 */}
          {variant === "default" && showCloseButton && (
            <DialogPrimitive.Close
              className="absolute right-3 top-3.5 z-10 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={closeLabel ?? t("common.close")}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      // `pr-12` 给内置叉号让位（标题/描述都是本组件的直接子元素）；写成 pl/pr 而不是
      // px，调用处才能用 `px-4` 之类一次性覆盖两边。
      "flex flex-col space-y-1.5 text-center sm:text-left pl-6 pr-12 py-5 border-b border-border-default bg-muted/20 flex-shrink-0",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:items-center px-6 py-5 border-t border-border-default bg-muted/20 flex-shrink-0",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

/**
 * 弹窗正文：头部/底部固定，正文自己滚。
 *
 * 它存在的原因是"能不能滚"不该由每个调用处各自想起来。正文原先直接写成
 * `<div className="space-y-4">`，父级是 `max-h-[90vh]` 的 flex 列，内容一长就顶穿
 * 弹窗画到边框外，而外层没有任何滚动容器——滚轮滚的是后面那个不可滚的层，于是
 * 「内容被截了，又滚不动」。这里一次给足 `min-h-0 flex-1 overflow-y-auto`。
 * 滚动条沿用全局的隐藏样式（index.css 里 `*::-webkit-scrollbar { display: none }`），
 * 与应用内其它滚动区一致；不占布局宽度，所以左右内边距与头部/底部同为 `px-6`。
 */
const DialogBody = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-5", className)}
    {...props}
  />
);
DialogBody.displayName = "DialogBody";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-tight tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
