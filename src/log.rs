extern crate cairo;
extern crate gdk;
use std::rc::Rc;
use std::cell::Cell;
use std::cell::RefCell;
use readline::ReadLineView;
use term::Term;
use view;
use view::Layout;

struct Prompt {
    rl: Rc<ReadLineView>,
}

impl Prompt {
    fn new(rl: Rc<ReadLineView>) -> Prompt {
        Prompt { rl: rl }
    }
}

impl view::View for Prompt {
    fn draw(&self, cr: &cairo::Context, focus: bool) {
        cr.save();
        cr.set_source_rgb(0.7, 0.7, 0.7);
        cr.new_path();
        cr.move_to(5.0, 8.0);
        let height = self.get_layout().height as f64;
        cr.line_to(13.0, height / 2.0);
        cr.line_to(5.0, height - 8.0);
        cr.fill();

        cr.translate(18.0, 5.0);
        self.rl.draw(cr, focus);
        cr.restore();
    }
    fn key(&self, ev: &gdk::EventKey) {
        self.rl.key(ev);
    }

    fn relayout(&self, cr: &cairo::Context, space: Layout) -> Layout {
        self.rl.relayout(cr, space.add(-20, -10));
        self.get_layout()
    }
    fn get_layout(&self) -> Layout {
        self.rl.get_layout().add(20, 10)
    }
}

pub struct LogEntry {
    prompt: Prompt,
    term: RefCell<Option<Term>>,
    layout: Cell<Layout>,
}

impl LogEntry {
    pub fn new(dirty: Rc<Fn()>,
               font_extents: &cairo::FontExtents,
               done: Box<Fn()>)
               -> Rc<LogEntry> {
        let le = Rc::new(LogEntry {
            prompt: Prompt::new(ReadLineView::new(dirty.clone())),
            term: RefCell::new(None),
            layout: Cell::new(Layout::new()),
        });

        let accept_cb = {
            // The accept callback from readline can potentially be
            // called multiple times, but we only want create a
            // terminal once.  Capture all the needed state in a
            // moveable temporary.
            let mut once = Some((le.clone(), dirty, font_extents.clone(), done));
            Box::new(move |str: &str| {
                if let Some(once) = once.take() {
                    let text = String::from(str);
                    view::add_task(move || {
                        let (le, dirty, font_extents, done) = once;
                        *le.term.borrow_mut() =
                            Some(Term::new(dirty, font_extents, &[&text], done));
                    })
                }
            })
        };
        le.prompt.rl.rl.borrow_mut().accept_cb = accept_cb;
        le
    }
}

impl view::View for LogEntry {
    fn draw(&self, cr: &cairo::Context, focus: bool) {
        if let Some(ref term) = *self.term.borrow() {
            self.prompt.draw(cr, false);
            cr.save();
            let height = self.prompt.get_layout().height as f64;
            cr.translate(0.0, height);
            term.draw(cr, focus);
            cr.restore();
        } else {
            self.prompt.draw(cr, focus);
        }
    }

    fn key(&self, ev: &gdk::EventKey) {
        if let Some(ref term) = *self.term.borrow() {
            term.key(ev);
        } else {
            self.prompt.key(ev);
        }
    }

    fn relayout(&self, cr: &cairo::Context, space: Layout) -> Layout {
        let mut layout = self.prompt.relayout(cr, space);
        if let Some(ref term) = *self.term.borrow() {
            let tlayout = term.relayout(cr,
                                        Layout {
                                            width: space.width,
                                            height: space.height - layout.height,
                                        });
            layout = layout.add(tlayout.width, tlayout.height);
        }
        self.layout.set(layout);
        layout
    }
    fn get_layout(&self) -> Layout {
        self.layout.get()
    }
}

pub struct Log {
    entries: Vec<Rc<LogEntry>>,
    dirty: Rc<Fn()>,
    font_extents: cairo::FontExtents,
    layout: Cell<Layout>,
}

impl Log {
    pub fn new(dirty: Rc<Fn()>, font_extents: &cairo::FontExtents) -> Rc<RefCell<Log>> {
        let log = Rc::new(RefCell::new(Log {
            entries: Vec::new(),
            dirty: dirty,
            font_extents: font_extents.clone(),
            layout: Cell::new(Layout::new()),
        }));
        Log::new_entry(&log);
        log
    }

    pub fn new_entry(log: &Rc<RefCell<Log>>) {
        let entry = {
            let log_ref = log.clone();
            let log = log.borrow();
            LogEntry::new(log.dirty.clone(),
                          &log.font_extents,
                          Box::new(move || {
                              Log::new_entry(&log_ref);
                          }))
        };
        log.borrow_mut().entries.push(entry);
    }
}

impl view::View for RefCell<Log> {
    fn draw(&self, cr: &cairo::Context, focus: bool) {
        let entries = &self.borrow().entries;
        cr.save();
        for (i, entry) in entries.iter().enumerate() {
            let last = i == entries.len() - 1;
            entry.draw(cr, focus && last);
            cr.translate(0.0, entry.get_layout().height as f64);
        }
        cr.restore();
    }
    fn key(&self, ev: &gdk::EventKey) {
        let entries = &self.borrow().entries;
        entries[entries.len() - 1].key(ev);
    }
    fn relayout(&self, cr: &cairo::Context, space: Layout) -> Layout {
        let log = self.borrow();
        let entries = &log.entries;
        let mut height = 0;
        for entry in entries {
            let entry_layout = entry.relayout(cr, space.add(0, -height));
            height += entry_layout.height;
        }
        log.layout.set(Layout {
            width: space.width,
            height: height,
        });
        log.layout.get()
    }
    fn get_layout(&self) -> Layout {
        let log = self.borrow();
        log.layout.get()
    }
}
