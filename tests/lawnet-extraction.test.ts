import { describe, expect, it } from "bun:test";
import { normalizeLawNetSearchRows } from "../src/extraction/index.js";

describe("LawNet search result normalization", () => {
  it("turns noisy heading soup into clean case rows", () => {
    const rows = normalizeLawNetSearchRows([
      {
        title: "Search Results",
        heading_1: "Catchword",
        heading_2: "Category",
        heading_9:
          "Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113    Court : High Court Corams : Vinodh Coomaraswamy J Decision Date : 28 June 2013 Case Number : Suit No 727 of 2009 (Registrar's Appeal No 273 of 2012) Catchword : Damages , Damages , Damages",
        heading_10: "Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113",
        heading_11:
          "Darwin-51 Car Rental v Yan Yin Lai Jean - [2023] SGMC 99    Court : Magistrates Court Corams : Andre Sim Jun Yi Decision Date : 07 December 2023 Case Number : Magistrate Court Suit No 5700 of 2020 (Assessment of Damages No 382 of 2021) Catchword : Tort , Civil Procedure , Evidence , Damages",
        heading_12: "Darwin-51 Car Rental v Yan Yin Lai Jean - [2023] SGMC 99",
        description: "Results returned: 294",
      },
      {
        title: "Title [A to Z]",
        heading_1: "Title [Z to A]",
        heading_2: "Please enter the no. of words before and after.",
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.title).toBe("Lai Wai Keong Eugene v Loo Wei Yen - [2013] 3 SLR 1113");
    expect(rows[0]?.case_name).toBe("Lai Wai Keong Eugene v Loo Wei Yen");
    expect(rows[0]?.citation).toBe("[2013] 3 SLR 1113");
    expect(rows[0]?.court).toBe("High Court");
    expect(rows[0]?.decision_date).toBe("28 June 2013");
    expect(rows[1]?.court).toBe("Magistrates Court");
    expect(rows[1]?.case_number).toContain("Assessment of Damages No 382 of 2021");
  });
});
