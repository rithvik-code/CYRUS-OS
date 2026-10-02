"""
The command palette. Deliberately plain Tkinter — ships with Python, no
extra dependency, and the UI is not the hard part of this project. Don't
let polish here become a distraction from getting the intent/action loop
solid.
"""

import tkinter as tk
from tkinter import font as tkfont


class Palette:
    def __init__(self, on_submit):
        """on_submit: callable(str) -> str  (takes user text, returns result message)"""
        self.on_submit = on_submit
        self.root = None

    def show(self):
        if self.root is not None:
            self.root.deiconify()
            self.root.lift()
            self.entry.focus_set()
            return

        self.root = tk.Tk()
        self.root.title("CYRUS")
        self.root.geometry("620x90")
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#1e1e1e")

        big_font = tkfont.Font(family="Helvetica", size=16)
        small_font = tkfont.Font(family="Helvetica", size=11)

        self.entry = tk.Entry(
            self.root, font=big_font, bg="#2b2b2b", fg="#f0f0f0",
            insertbackground="#f0f0f0", relief="flat", bd=10,
        )
        self.entry.pack(fill="x", padx=12, pady=(12, 4))
        self.entry.focus_set()

        self.result_label = tk.Label(
            self.root, text="", font=small_font, bg="#1e1e1e", fg="#9fdf9f",
            anchor="w", justify="left", wraplength=580,
        )
        self.result_label.pack(fill="x", padx=14, pady=(0, 10))

        self.entry.bind("<Return>", self._submit)
        self.root.bind("<Escape>", lambda e: self.hide())

        self.root.mainloop()

    def _submit(self, event):
        text = self.entry.get().strip()
        if not text:
            return
        self.entry.delete(0, tk.END)
        self.result_label.configure(text="Thinking...", fg="#dddd88")
        self.root.update_idletasks()
        result = self.on_submit(text)
        self.result_label.configure(text=result, fg="#9fdf9f")

    def hide(self):
        if self.root is not None:
            self.root.withdraw()

    def confirm(self, message: str) -> bool:
        """Blocking yes/no dialog for medium/high risk actions."""
        confirm_win = tk.Toplevel(self.root)
        confirm_win.title("Confirm")
        confirm_win.attributes("-topmost", True)
        confirm_win.geometry("420x140")
        confirm_win.configure(bg="#1e1e1e")

        result = {"value": False}

        tk.Label(
            confirm_win, text=message, wraplength=380, justify="left",
            bg="#1e1e1e", fg="#f0f0f0", font=("Helvetica", 11),
        ).pack(padx=16, pady=16)

        def yes():
            result["value"] = True
            confirm_win.destroy()

        def no():
            result["value"] = False
            confirm_win.destroy()

        btn_frame = tk.Frame(confirm_win, bg="#1e1e1e")
        btn_frame.pack(pady=8)
        tk.Button(btn_frame, text="Cancel", command=no).pack(side="left", padx=8)
        tk.Button(btn_frame, text="Confirm", command=yes, bg="#c0392b", fg="white").pack(side="left", padx=8)

        confirm_win.wait_window()
        return result["value"]
