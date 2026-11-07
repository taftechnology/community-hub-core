import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold as BoldIcon,
  Heading2 as Heading2Icon,
  Heading3 as Heading3Icon,
  Italic as ItalicIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
} from "lucide-react";
import * as React from "react";

import { Button } from "./button";
import { cn } from "./lib/utils";

export interface RichTextEditorToolbarLabels {
  heading2: string;
  heading3: string;
  bold: string;
  italic: string;
  bulletList: string;
  orderedList: string;
}

export interface RichTextEditorProps {
  label: string;
  toolbarLabel: string;
  toolbar: RichTextEditorToolbarLabels;
  placeholder?: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  maxLength?: number;
  counterLabel?: (used: number, max: number) => string;
  initialValue?: string;
  onChange?: (html: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Test and host integration hook to access the underlying editor */
  onEditorReady?: (editor: Editor) => void;
  className?: string;
}

export interface RichTextEditorHandle {
  getHTML(): string;
  setContent(html: string): void;
  focus(): void;
}

interface ToolbarItem {
  id: "h2" | "h3" | "bold" | "italic" | "bullet" | "ordered";
  label: string;
  icon: React.ComponentType<{ "aria-hidden"?: boolean | "true" | "false"; className?: string }>;
  isActive: (editor: Editor) => boolean;
  action: (editor: Editor) => void;
}

export const RichTextEditor = React.forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor(
    {
      label,
      toolbarLabel,
      toolbar,
      placeholder,
      describedBy,
      invalid = false,
      disabled = false,
      maxLength,
      counterLabel,
      initialValue,
      onChange,
      onFocus,
      onBlur,
      onEditorReady,
      className,
    },
    ref,
  ) {
    const isSettingContentRef = React.useRef(false);
    const [, setTxCount] = React.useState(0);
    const [contentLength, setContentLength] = React.useState<number>(() => {
      return initialValue ? initialValue.length : 7; // <p></p>.length is 7
    });

    const isOverLimit = maxLength !== undefined && contentLength > maxLength;
    const isEffectivelyInvalid = invalid || isOverLimit;

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          strike: false,
          link: false,
          underline: false,
          heading: {
            levels: [1, 2, 3, 4],
          },
        }),
      ],
      ...(initialValue !== undefined ? { content: initialValue } : {}),
      editable: !disabled,
      injectCSS: false,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          tabindex: "0",
          ...(describedBy ? { "aria-describedby": describedBy } : {}),
          "aria-invalid": String(Boolean(isEffectivelyInvalid)),
          ...(placeholder ? { "data-placeholder": placeholder } : {}),
          class: "outline-hidden",
        },
      },
      onUpdate({ editor: currentEditor, transaction }) {
        if (isSettingContentRef.current) {
          return;
        }
        if (transaction.docChanged) {
          const html = currentEditor.getHTML();
          setContentLength(html.length);
          onChange?.(html);
        }
      },
      onFocus() {
        onFocus?.();
      },
      onBlur() {
        onBlur?.();
      },
    });

    // Notify test or host integration when editor is ready
    React.useEffect(() => {
      if (editor && onEditorReady) {
        onEditorReady(editor);
      }
    }, [editor, onEditorReady]);

    // Re-render toolbar when editor transaction occurs (formatting, selection change)
    React.useEffect(() => {
      if (!editor) return;
      const onTransaction = () => {
        setTxCount((c) => c + 1);
      };
      editor.on("transaction", onTransaction);
      return () => {
        editor.off("transaction", onTransaction);
      };
    }, [editor]);

    // Keep editable in sync
    React.useEffect(() => {
      if (editor && editor.isEditable !== !disabled) {
        editor.setEditable(!disabled);
      }
    }, [editor, disabled]);

    // Update attributes when props change
    React.useEffect(() => {
      if (!editor) return;
      editor.setOptions({
        editorProps: {
          attributes: {
            role: "textbox",
            "aria-multiline": "true",
            "aria-label": label,
            tabindex: "0",
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            "aria-invalid": String(Boolean(isEffectivelyInvalid)),
            ...(placeholder ? { "data-placeholder": placeholder } : {}),
            class: "outline-hidden",
          },
        },
      });
      if (editor.view?.dom) {
        editor.view.dom.setAttribute("aria-invalid", String(Boolean(isEffectivelyInvalid)));
        if (describedBy) {
          editor.view.dom.setAttribute("aria-describedby", describedBy);
        } else {
          editor.view.dom.removeAttribute("aria-describedby");
        }
        editor.view.dom.setAttribute("aria-label", label);
      }
    }, [editor, label, describedBy, isEffectivelyInvalid, placeholder]);

    // Expose handle
    React.useImperativeHandle(
      ref,
      () => ({
        getHTML(): string {
          return editor ? editor.getHTML() : (initialValue ?? "<p></p>");
        },
        setContent(html: string): void {
          if (!editor) return;
          isSettingContentRef.current = true;
          try {
            editor.commands.setContent(html, { emitUpdate: false });
            const len = editor.getHTML().length;
            setContentLength(len);
            const over = maxLength !== undefined && len > maxLength;
            if (editor.view?.dom) {
              editor.view.dom.setAttribute("aria-invalid", String(Boolean(invalid || over)));
            }
          } finally {
            isSettingContentRef.current = false;
          }
        },
        focus(): void {
          editor?.commands.focus();
          if (editor?.view?.dom) {
            (editor.view.dom as HTMLElement).focus();
          }
        },
      }),
      [editor, initialValue, invalid, maxLength],
    );

    // Toolbar items
    const toolbarItems: ToolbarItem[] = React.useMemo(
      () => [
        {
          id: "h2",
          label: toolbar.heading2,
          icon: Heading2Icon,
          isActive: (ed) => ed.isActive("heading", { level: 2 }),
          action: (ed) => ed.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
          id: "h3",
          label: toolbar.heading3,
          icon: Heading3Icon,
          isActive: (ed) => ed.isActive("heading", { level: 3 }),
          action: (ed) => ed.chain().focus().toggleHeading({ level: 3 }).run(),
        },
        {
          id: "bold",
          label: toolbar.bold,
          icon: BoldIcon,
          isActive: (ed) => ed.isActive("bold"),
          action: (ed) => ed.chain().focus().toggleBold().run(),
        },
        {
          id: "italic",
          label: toolbar.italic,
          icon: ItalicIcon,
          isActive: (ed) => ed.isActive("italic"),
          action: (ed) => ed.chain().focus().toggleItalic().run(),
        },
        {
          id: "bullet",
          label: toolbar.bulletList,
          icon: ListIcon,
          isActive: (ed) => ed.isActive("bulletList"),
          action: (ed) => ed.chain().focus().toggleBulletList().run(),
        },
        {
          id: "ordered",
          label: toolbar.orderedList,
          icon: ListOrderedIcon,
          isActive: (ed) => ed.isActive("orderedList"),
          action: (ed) => ed.chain().focus().toggleOrderedList().run(),
        },
      ],
      [toolbar],
    );

    // Roving tabindex on toolbar
    const [focusedIndex, setFocusedIndex] = React.useState(0);
    const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

    const handleToolbarKeyDown = (e: React.KeyboardEvent, index: number) => {
      let nextIndex = index;
      const count = toolbarItems.length;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        nextIndex = (index + 1) % count;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        nextIndex = (index - 1 + count) % count;
      } else if (e.key === "Home") {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === "End") {
        e.preventDefault();
        nextIndex = count - 1;
      } else {
        return;
      }
      setFocusedIndex(nextIndex);
      buttonRefs.current[nextIndex]?.focus();
    };

    return (
      <div
        className={cn("ch-rich-text-editor", className)}
        data-invalid={isEffectivelyInvalid ? "true" : "false"}
        data-disabled={disabled ? "true" : "false"}
      >
        <div role="toolbar" aria-label={toolbarLabel} className="ch-rich-text-toolbar">
          {toolbarItems.map((item, index) => {
            const Icon = item.icon;
            const active = editor ? item.isActive(editor) : false;
            return (
              <Button
                key={item.id}
                ref={(el) => {
                  buttonRefs.current[index] = el;
                }}
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="icon"
                disabled={disabled}
                tabIndex={focusedIndex === index && !disabled ? 0 : -1}
                aria-label={item.label}
                aria-pressed={active ? "true" : "false"}
                className={cn(
                  active && "bg-secondary text-secondary-foreground",
                  "touch:size-(--ch-size-touch)",
                )}
                onClick={() => {
                  if (editor) {
                    item.action(editor);
                  }
                }}
                onKeyDown={(e) => handleToolbarKeyDown(e, index)}
                onFocus={() => setFocusedIndex(index)}
              >
                <Icon aria-hidden="true" />
              </Button>
            );
          })}
        </div>

        <EditorContent editor={editor} className="ch-rich-text-content" />

        {maxLength !== undefined && counterLabel && (
          <div
            className="ch-rich-text-counter"
            data-over={isOverLimit ? "true" : "false"}
            aria-live="polite"
            aria-atomic="true"
          >
            {counterLabel(contentLength, maxLength)}
          </div>
        )}
      </div>
    );
  },
);
