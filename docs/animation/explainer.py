# /// script
# requires-python = ">=3.13"
# dependencies = ["manim==0.21.0"]
# ///
"""A narrated Manim lesson built from one worked example."""
import json
from pathlib import Path
import re
import sys
import textwrap
import wave
from manim import *

ROOT = Path(__file__).resolve().parent
SILENT = "--silent" in sys.argv
STEM = "discern-explainer-silent" if SILENT else "discern-explainer"
STORY = json.loads((ROOT / ("silent-captions.json" if SILENT else "narration.json")).read_text(encoding="utf-8"))
SOURCE = (ROOT.parent.parent / "examples/explainer.ts").read_text(encoding="utf-8")
BG, PANEL = "#0C1220", "#172338"
INK, MUTED = "#EEF3FF", "#A7B5CD"
TEAL, BLUE, AMBER, RED = "#58E0BE", "#81ADFF", "#FFCD70", "#FF8A99"


def text(s, size=28, color=INK, mono=False):
    return Text(s, font="Consolas" if mono else "Segoe UI", font_size=size,
                color=color, disable_ligatures=True, line_spacing=0.7)


def fit(m, width=12):
    if m.width > width:
        m.scale_to_fit_width(width)
    return m


def card(title, subtitle="", color=TEAL, width=3.4, height=1.3):
    box = RoundedRectangle(width=width, height=height, corner_radius=.13,
                           stroke_color=color, stroke_width=1.6,
                           fill_color=PANEL, fill_opacity=1)
    title = fit(text(title, 26, color), width-.35)
    if not subtitle:
        return VGroup(box, title)
    title.move_to(UP*.24)
    desc = fit(text(subtitle, 20, MUTED), width-.35).move_to(DOWN*.27)
    return VGroup(box, title, desc)


def code(name, size=25):
    fragment = re.search(r"// video:" + name + r"\n(.*?)\n// endvideo", SOURCE, re.S).group(1)
    return fit(text(fragment, size, INK, True), 12.1)


def arrow(a, b, color=TEAL):
    return Arrow(a.get_right(), b.get_left(), buff=.13, color=color, stroke_width=3)


class DiscernExplainer(Scene):
    def begin(self, index, layer):
        if self.mobjects:
            self.play(*[FadeOut(m) for m in list(self.mobjects)], run_time=.35)
        self.chapter = STORY[index]
        self.cue = 0
        self.subtitle = None
        nav = VGroup(*[text(s, 18, TEAL if i == layer else MUTED)
                       for i,s in enumerate(["1  Jev", "2  Decision", "3  Discern", "4  Procedures"])]).arrange(RIGHT, buff=.7)
        nav.to_edge(UP, buff=.27)
        title = fit(text(self.chapter["title"], 36), 12.5).move_to(UP*2.63)
        rail = RoundedRectangle(width=13.2, height=1.15, corner_radius=.08,
                                fill_color=PANEL, fill_opacity=1, stroke_width=0).move_to(DOWN*3.18)
        self.add(nav, rail)
        self.play(FadeIn(title), run_time=.35)

    def say(self, *animations, run_time=.8):
        line = self.chapter["cues"][self.cue]
        audio = ROOT / "media/audio" / f'{self.chapter["id"]}-{self.cue}.wav'
        if SILENT:
            # Readable short holds, including time to scan the accompanying diagram.
            duration = max(3.0, len(line.split()) / 3.5)
        else:
            with wave.open(str(audio)) as wav:
                duration = wav.getnframes() / wav.getframerate()
        if self.subtitle is not None:
            self.remove(self.subtitle)
        self.subtitle = text(textwrap.fill(line, width=105), 21).move_to(DOWN*3.18)
        fit(self.subtitle, 12.65)
        if self.subtitle.height > .94:
            self.subtitle.scale_to_fit_height(.94)
        self.add(self.subtitle)
        self.timeline.append({"chapter":self.chapter["id"],"title":self.chapter["title"],
                              "cue":self.cue,"start":self.time,"end":self.time+duration,"text":line})
        if not SILENT:
            self.add_sound(str(audio))
        start = self.time
        if animations:
            self.play(*animations, run_time=run_time)
        self.wait(max(.1, duration+(.15 if SILENT else .65)-(self.time-start)))
        self.cue += 1

    def construct(self):
        self.camera.background_color = BG
        self.timeline = []

        # JEV: context, question, then output.
        self.begin(0,0)
        jev = card("Jev","TypeSafe's judgment model",TEAL,4.4).move_to(UP*.35)
        self.say(FadeIn(jev,shift=UP*.1))
        change = card("Context","Remove the retry field",BLUE,3.6).move_to(LEFT*4.65+UP*.4)
        q = fit(text('"Will this change cause a regression?"',29,BLUE),11).move_to(DOWN*1.15)
        self.say(jev.animate.scale(.8),FadeIn(change),FadeIn(q))
        ans = card("0.62","estimated probability",AMBER,3.2).move_to(RIGHT*4.8+UP*.4)
        note = text("Illustrative model answers throughout this lesson",18,MUTED).move_to(DOWN*2.05)
        self.say(Create(VGroup(arrow(change,jev),arrow(jev,ans))),FadeIn(ans),FadeIn(note))

        self.begin(1,0)
        rows = VGroup(card("Noul","Probability of yes",AMBER,3.8),
                      card("Choice","Named alternatives",BLUE,3.8),
                      card("Score","Ordered levels",TEAL,3.8)).arrange(RIGHT,buff=.3).move_to(UP*.7)
        self.say(LaggedStart(*[FadeIn(c) for c in rows],lag_ratio=.25))
        examples = VGroup(text("Regression?\n0.62",26,AMBER),
                          text("API impact?\nbreaking / compatible",24,BLUE),
                          text("Severity?\nlow / medium / high",24,TEAL))
        for i,e in enumerate(examples):
            e.move_to([rows[i].get_x(),-.95,0])
        self.say(FadeIn(examples))

        # DECISION: construction is separate from execution.
        self.begin(2,1)
        definition = code("decision",29).move_to(UP*.9)
        note = text("A definition is data. No model call yet.",25,AMBER).move_to(DOWN*.25)
        self.say(FadeIn(definition),FadeIn(note))
        mapping = VGroup(*[VGroup(text(a,27,BLUE,True),text("↓",24,MUTED),text(b,27,TEAL,True))
                           .arrange(DOWN,buff=.15).move_to([x,-1.4,0])
                           for a,b,x in [("probability","Noul",-4),("classify","Choice",0),("rate","Score",4)]])
        self.say(FadeIn(mapping))

        self.begin(3,1)
        defs = card("Decision + input","risk question + change",BLUE,3.5).move_to(LEFT*4.55+UP*.5)
        service = card("DecisionModel","TypeSafe provider",TEAL,3.7).move_to(UP*.5)
        model = card("Jev","answers the question",TEAL,2.9).move_to(RIGHT*4.5+UP*.5)
        self.say(FadeIn(defs),FadeIn(service),FadeIn(model),Create(VGroup(arrow(defs,service),arrow(service,model))))
        call = fit(text("DecisionModel.decide(questions, { input: change })",26,BLUE,True)).move_to(DOWN*.8)
        result = text("answers.risk.probability  →  0.62",29,AMBER,True).move_to(DOWN*1.65)
        self.say(FadeIn(call),FadeIn(result))

        # DISCERN: motivate the third outcome before introducing its APIs.
        self.begin(4,2)
        p = card("Evidence","risk = 0.62",AMBER,3.2).move_to(LEFT*4.5+UP*.65)
        test = card("risk >= 0.8","false",BLUE,3.3).move_to(UP*.65)
        self.say(FadeIn(p),FadeIn(test),GrowArrow(arrow(p,test)))
        ship = card("ship?","fallback",RED,2.9).move_to(RIGHT*4.5+UP*.65)
        gap = fit(text("Below the blocking threshold ≠ evidence of safety",30,AMBER)).move_to(DOWN*1.05)
        self.say(FadeIn(ship),GrowArrow(arrow(test,ship,RED)),FadeIn(gap))

        self.begin(5,2)
        pattern = code("pattern",24).move_to(UP*1.05)
        self.say(FadeIn(pattern))
        zones = VGroup()
        for lo,hi,c in [(0,.5,BLUE),(.5,.8,AMBER),(.8,1,TEAL)]:
            zones.add(Rectangle(width=(hi-lo)*10.8,height=.22,stroke_width=0,
                               fill_color=c,fill_opacity=1).move_to([-5.4+(lo+hi)*5.4,-.65,0]))
        labels = VGroup(text("Miss",24,BLUE).move_to([-2.7,-1.2,0]),
                        text("Uncertain",24,AMBER).move_to([1.62,-1.2,0]),
                        text("Match",24,TEAL).move_to([4.32,-1.2,0]))
        ticks = VGroup(*[text(s,18,MUTED,True).move_to([-5.4+v*10.8,-1.7,0])
                        for v,s in [(0,"0"),(.5,"0.50"),(.8,"0.80"),(1,"1")]])
        dot = Dot([4.32,-.65,0],radius=.11,color=INK).set_z_index(3)
        number = text("0.90 → Match",24,TEAL).move_to(UP*-.15)
        self.say(Create(zones),FadeIn(labels),FadeIn(ticks),FadeIn(dot),FadeIn(number))
        self.say(dot.animate.move_to([-3.24,-.65,0]),
                 Transform(number,text("0.20 → Miss",24,BLUE).move_to(UP*-.15)))
        self.say(dot.animate.move_to([1.296,-.65,0]),
                 Transform(number,text("0.62 → Uncertain",24,AMBER).move_to(UP*-.15)))

        self.begin(6,2)
        policy = code("policy",29).move_to(UP*.7)
        self.say(FadeIn(policy))
        flow = VGroup(card("0.62","evidence",AMBER,2.6),card("Uncertain","pattern result",AMBER,3.3),
                      card("human-review","policy result",AMBER,3.6)).arrange(RIGHT,buff=.6).move_to(DOWN*1.2)
        self.say(FadeIn(flow),Create(VGroup(arrow(flow[0],flow[1],AMBER),arrow(flow[1],flow[2],AMBER))))
        note = text("Example policy: thresholds must fit your application.",22,MUTED).move_to(DOWN*2.15)
        self.say(FadeIn(note))

        self.begin(7,2)
        combined = code("combined",24).move_to(UP*.6)
        self.say(FadeIn(combined))
        batch = fit(text("ONE CALL: impact + risk  →  reused across the rules",24,TEAL,True)).move_to(DOWN*1.25)
        self.say(FadeIn(batch))
        stop = text("First rule uncertain? Stop → human-review",26,AMBER).move_to(DOWN*2)
        self.say(FadeIn(stop))

        # PROCEDURES: direct call before routing; routing before nesting.
        self.begin(8,3)
        proc = code("procedure",26).move_to(UP*.75)
        self.say(FadeIn(proc))
        shape = text("Request = { ask, change }  →  review(change)",24,BLUE,True).move_to(DOWN*.85)
        self.say(FadeIn(shape))
        direct = text("reviewChange.run(request)",30,TEAL,True).move_to(DOWN*1.65)
        self.say(FadeIn(direct))

        self.begin(9,3)
        reg = code("registry",22).move_to(UP*1.65)
        review = card("review","run the release policy",TEAL,4.7).move_to(LEFT*3.2)
        explain = card("explain","return the given summary",BLUE,4.7).move_to(RIGHT*3.2)
        self.say(FadeIn(reg),FadeIn(review),FadeIn(explain))
        ask = text('"Is this safe to ship?"',29,INK).move_to(UP*.95)
        probs = VGroup(text("0.92",32,TEAL).move_to(LEFT*3.2+DOWN*1),
                       text("0.08",32,MUTED).move_to(RIGHT*3.2+DOWN*1))
        self.say(FadeIn(ask),FadeIn(probs))
        selected = SurroundingRectangle(review,color=TEAL,buff=.08,corner_radius=.15)
        invoke = fit(text("changes.invoke(request) → reviewChange.run(request)",25,TEAL,True)).move_to(DOWN*1.9)
        self.say(Create(selected),explain.animate.set_opacity(.35),FadeIn(invoke))

        self.begin(10,3)
        ask = text('"Can you look at this?"',31).move_to(UP*1.4)
        choices = VGroup(card("review  0.52","",BLUE,4.7),card("explain  0.48","",BLUE,4.7)).arrange(RIGHT,buff=.7).move_to(UP*.2)
        self.say(FadeIn(ask),FadeIn(choices))
        thresholds = text("Need: top ≥ 0.70 AND lead ≥ 0.15",27,AMBER).move_to(DOWN*.95)
        result = text('onUncertain → "Review or explain?"',29,AMBER,True).move_to(DOWN*1.8)
        self.say(FadeIn(thresholds),FadeIn(result))

        self.begin(11,3)
        top = card("assistant","registry",BLUE,2.6,1).move_to(LEFT*4.65+UP*.95)
        group = card("code","nested registry",TEAL,2.7,1).move_to(LEFT*.8+UP*.95)
        help_ = card("help","instructions",MUTED,2.7,1).move_to(LEFT*.8+DOWN*.7)
        review = card("review","release policy",TEAL,2.8,1).move_to(RIGHT*3.65+UP*.95)
        explain = card("explain","given summary",MUTED,2.8,1).move_to(RIGHT*3.65+DOWN*.7)
        edges = VGroup(arrow(top,group),arrow(top,help_,MUTED),arrow(group,review),arrow(group,explain,MUTED))
        tree = VGroup(top,group,help_,review,explain,edges)
        self.say(FadeIn(tree))
        path = VGroup(SurroundingRectangle(top,color=TEAL,buff=.06),
                      SurroundingRectangle(group,color=TEAL,buff=.06),
                      SurroundingRectangle(review,color=TEAL,buff=.06))
        verdict = text("risk = 0.62 → human-review",27,AMBER).move_to(DOWN*2.15)
        self.say(LaggedStart(*[Create(p) for p in path],lag_ratio=.9),FadeIn(verdict),run_time=3.5)
        calls = text("1  choose code       2  choose review       3  judge risk",22,BLUE,True).move_to(DOWN*1.55)
        self.say(FadeIn(calls))
        composition = VGroup(text("Known sequence: review.run → explain.run",27,TEAL,True),
                             text("Nested routing: withMaxDepth(4)",27,BLUE,True),
                             text("Record → inspect the tree → replay",27,AMBER)).arrange(DOWN,buff=.48).move_to(ORIGIN)
        self.say(FadeOut(tree),FadeOut(path),FadeOut(calls),FadeOut(verdict),FadeIn(composition))

        self.begin(12,3)
        layers = VGroup(*[card(a,b,c,11,1) for a,b,c in [
            ("Jev","produce a semantic judgment",TEAL),
            ("Decision / DecisionModel","define a question / ask a provider",BLUE),
            ("Discern","interpret evidence and choose a branch",AMBER),
            ("Procedures / registries","package programs / route and compose",TEAL),
        ]]).arrange(DOWN,buff=.14).move_to(UP*.05)
        self.say(LaggedStart(*[FadeIn(l) for l in layers[:3]],lag_ratio=.3))
        self.say(FadeIn(layers[3]))
        self.wait(1)
        timeline_name = "timeline-silent.json" if SILENT else "timeline.json"
        (ROOT / "media" / timeline_name).write_text(json.dumps(self.timeline,indent=2),encoding="utf-8")


if __name__ == "__main__":
    missing = [f'{c["id"]}-{i}.wav' for c in STORY for i in range(len(c["cues"]))
               if not (ROOT / "media/audio" / f'{c["id"]}-{i}.wav').exists()]
    if missing and not SILENT:
        raise SystemExit("Generate narration first: powershell -File docs/animation/narrate.ps1")
    with tempconfig({"pixel_width":1280,"pixel_height":720,"frame_rate":30,
                     "media_dir":str(ROOT / "media"),"output_file":STEM,
                     "disable_caching":True}):
        DiscernExplainer().render()
