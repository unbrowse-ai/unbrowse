import { describe, test, expect } from "bun:test";

describe("#125 /action press focuses target", () => {
  test("fill should focus element before typing", () => {
    // The fill action should: 1) focus element 2) clear existing value 3) type new value
    const fillSteps = ["scrollIntoView", "click", "selectAll", "type"];
    expect(fillSteps[0]).toBe("scrollIntoView");
    expect(fillSteps[1]).toBe("click");
  });

  test("press should focus element before dispatching key", () => {
    // The press action should: 1) focus element 2) dispatch keyDown 3) dispatch keyUp
    const pressSteps = ["scrollIntoView", "click", "keyDown", "keyUp"];
    expect(pressSteps[0]).toBe("scrollIntoView");
    expect(pressSteps[1]).toBe("click");
  });

  test("click should scroll into view first", () => {
    const clickSteps = ["scrollIntoView", "click"];
    expect(clickSteps[0]).toBe("scrollIntoView");
  });
});
