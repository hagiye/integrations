import { emailKey, formatAddress, readIdentityFields, toE164, toIsoDate } from "./fayda.claims";

describe("toE164", () => {
  it.each([
    ["0911223344", "+251911223344"],
    ["0711223344", "+251711223344"],
    ["911223344", "+251911223344"],
    ["251911223344", "+251911223344"],
    ["+251 91 122 3344", "+251911223344"],
    ["+251-711-223344", "+251711223344"],
    ["77123456", "+25377123456"],
    ["25377123456", "+25377123456"],
    ["+25377123456", "+25377123456"],
    ["+14155550123", "+14155550123"],
    // A Djibouti mobile: EDR's normalizer (libphonenumber, ET then DJ) reads it the same way.
    ["77834567", "+25377834567"],
  ])("reads %s as %s", (raw, e164) => expect(toE164(raw)).toBe(e164));

  it.each([["12345678"], ["0111223344"], ["+2511234"], ["25321123456"], ["9110217979"], ["abc"], ["0911x23344"], [""], ["+12"]])(
    "leaves %s unread (kept raw, never made to look canonical)",
    (raw) => expect(toE164(raw)).toBeUndefined(),
  );
});

describe("toIsoDate", () => {
  it("reads yyyy/MM/dd (eSignet) and yyyy-MM-dd", () => {
    expect(toIsoDate("1990/05/01")).toBe("1990-05-01");
    expect(toIsoDate("1990-05-01")).toBe("1990-05-01");
  });
  it("refuses impossible dates and other shapes", () => {
    expect(toIsoDate("1990/02/30")).toBeUndefined();
    expect(toIsoDate("01/05/1990")).toBeUndefined();
    expect(toIsoDate("1990")).toBeUndefined();
  });
});

describe("formatAddress", () => {
  it("uses formatted#locale when present", () => {
    expect(formatAddress({ "formatted#en": "Bole, Addis Ababa", "region#en": "x" }, "en")).toBe("Bole, Addis Ababa");
  });
  it("joins localised parts in EDR's order, then the rest", () => {
    expect(
      formatAddress({ "region#en": "Addis Ababa", "woreda#en": "Woreda 03", "subCity#en": "Bole", "extra#en": "Gate 2", "region#am": "አዲስ" }, "en"),
    ).toBe("Woreda 03, Bole, Addis Ababa, Gate 2");
    expect(formatAddress({ "region#am": "አዲስ አበባ" }, "am")).toBe("አዲስ አበባ");
  });
  it("takes a plain string as it is, and ignores what is not an address", () => {
    expect(formatAddress("Bole Sub City, Addis Ababa", "en")).toBe("Bole Sub City, Addis Ababa");
    expect(formatAddress(["x"], "en")).toBeUndefined();
    expect(formatAddress({}, "en")).toBeUndefined();
  });
});

describe("readIdentityFields", () => {
  it("maps eSignet's localised claims as EDR's freight copy does", () => {
    const fields = readIdentityFields({
      sub: "psut-1",
      "name#en": "Abebe Bekele",
      "name#am": "አበበ በቀለ",
      "gender#en": "Male",
      "gender#am": "ወንድ",
      birthdate: "1990/05/01",
      phone_number: "0911223344",
      email: " abebe@example.com ",
      "address#en": { "region#en": "Addis Ababa" },
      nationality: "ETH",
    });
    expect(fields).toEqual({
      sub: "psut-1",
      fullName: "Abebe Bekele",
      nameEn: "Abebe Bekele",
      nameAm: "አበበ በቀለ",
      gender: "Male",
      genderEn: "Male",
      genderAm: "ወንድ",
      birthdate: "1990-05-01",
      phoneE164: "+251911223344",
      phoneRaw: "0911223344",
      email: "abebe@example.com",
      addressEn: "Addis Ababa",
      nationality: "ETH",
    });
  });

  it("prefers name over the localised names, and takes phone from its other spellings", () => {
    const fields = readIdentityFields({ sub: "s", name: "Given", "name#en": "En", "phone_number#en": "+251911000000" });
    expect(fields.fullName).toBe("Given");
    expect(fields.phoneE164).toBe("+251911000000");
    expect(readIdentityFields({ sub: "s", phone: "77123456" }).phoneE164).toBe("+25377123456");
  });

  it("keeps an unreadable phone raw only, and leaves absent claims out", () => {
    const fields = readIdentityFields({ sub: "s", phone_number: "77834567x" });
    expect(fields).toEqual({ sub: "s", phoneRaw: "77834567x" });
  });

  it("makes an email key for comparing contacts", () => {
    expect(emailKey(" Abebe.Bekele@Example.COM ")).toBe("abebe.bekele@example.com");
    expect(emailKey("")).toBeUndefined();
  });
});
