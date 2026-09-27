using System.Globalization;
using System.Text.RegularExpressions;

namespace SmAsia.Web.Services.Parsing;

/// <summary>Helpers for the product text found on invoices and reports.</summary>
public static partial class ProductText
{
    /// <summary>
    /// Reads the number of sellable units in a case from a pack-size string:
    /// "24/425g" → 24, "24x78g" → 24, "20x(10x33g)" → 20, "10/10/42g" → 10, "6x5x85g" → 6.
    /// </summary>
    public static int? PackUnits(string? description)
    {
        if (string.IsNullOrEmpty(description)) return null;
        var m = PackRegex().Match(description);
        if (!m.Success) return null;
        return int.TryParse(m.Groups[1].Value, out var n) && n is > 0 and <= 1000 ? n : null;
    }

    /// <summary>Digits only, leading zeros removed — makes UPC-A, EAN-13 and PLU-style codes comparable.</summary>
    public static string? NormalizeBarcode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var digits = new string(code.Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return null;
        digits = digits.TrimStart('0');
        return digits.Length == 0 ? "0" : digits;
    }

    /// <summary>
    /// True when two barcodes refer to the same item. Suppliers often print UPCs without the
    /// check digit (11 of 12 digits), so a code that equals the other minus its last digit also matches.
    /// </summary>
    public static bool BarcodesMatch(string? a, string? b)
    {
        var x = NormalizeBarcode(a);
        var y = NormalizeBarcode(b);
        if (x == null || y == null || x.Length < 6 || y.Length < 6) return x != null && x == y;
        if (x == y) return true;
        if (x.Length == y.Length + 1 && x[..^1] == y) return true;
        if (y.Length == x.Length + 1 && y[..^1] == x) return true;
        return false;
    }

    /// <summary>Lower-case letters and digits only, for loose name comparison.</summary>
    public static string NameKey(string? name) =>
        string.IsNullOrWhiteSpace(name) ? "" : new string(name.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());

    public static string CleanDescription(string text)
    {
        text = UpcRegex().Replace(text, " ");
        text = Regex.Replace(text, @"\*+GST\*+", " ", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, @"(^|\s)\*+", "$1");
        text = Regex.Replace(text, @"\s+NP\s*$", "");
        return Regex.Replace(text, @"\s{2,}", " ").Trim();
    }

    public static string? ExtractUpc(string text)
    {
        var m = UpcRegex().Match(text);
        return m.Success ? m.Groups[1].Value : null;
    }

    /// <summary>Parses the loose date formats seen in spreadsheets and invoices (9-28-28, 02/29/29, 17-Sep-26, Aug 04, 2026).</summary>
    public static DateOnly? ParseLooseDate(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        string[] formats =
        [
            "d-MMM-yy", "dd-MMM-yy", "d-MMM-yyyy", "MMM dd, yyyy", "MMM d, yyyy", "yyyy-MM-dd", "M/d/yyyy", "MM/dd/yyyy",
            "M-d-yyyy", "M/d/yy", "MM/dd/yy", "M-d-yy", "MM-dd-yy", "d/M/yyyy", "dd.MM.yyyy", "yyyy/MM/dd"
        ];
        if (DateTime.TryParseExact(s, formats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var dt))
            return DateOnly.FromDateTime(dt);

        // Month-day-year with an impossible day (e.g. 02/29/29) → clamp to month end.
        var m = Regex.Match(s, @"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$");
        if (m.Success)
        {
            int month = int.Parse(m.Groups[1].Value), day = int.Parse(m.Groups[2].Value), year = int.Parse(m.Groups[3].Value);
            if (year < 100) year += 2000;
            if (month is >= 1 and <= 12 && day >= 1)
                return new DateOnly(year, month, Math.Min(day, DateTime.DaysInMonth(year, month)));
        }
        // "08/2027" or "8-27" → end of that month
        m = Regex.Match(s, @"^(\d{1,2})[-/](\d{2}|\d{4})$");
        if (m.Success)
        {
            int month = int.Parse(m.Groups[1].Value), year = int.Parse(m.Groups[2].Value);
            if (year < 100) year += 2000;
            if (month is >= 1 and <= 12) return new DateOnly(year, month, DateTime.DaysInMonth(year, month));
        }
        if (DateTime.TryParse(s, CultureInfo.GetCultureInfo("en-CA"), DateTimeStyles.None, out dt))
            return DateOnly.FromDateTime(dt);
        return null;
    }

    [GeneratedRegex(@"(?<![\d.])(\d{1,4})\s*[/xX]\s*\(?\s*\d")]
    private static partial Regex PackRegex();

    [GeneratedRegex(@"UPC\s*:?\s*(\d{4,14})", RegexOptions.IgnoreCase)]
    private static partial Regex UpcRegex();
}
