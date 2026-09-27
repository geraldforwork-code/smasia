using System.Globalization;
using System.Text.RegularExpressions;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

namespace SmAsia.Web.Services.Parsing;

public record PdfWord(string Text, double Left, double Right, double Bottom, int Page)
{
    public double Center => (Left + Right) / 2;
}

public record PdfLine(int Page, double Y, IReadOnlyList<PdfWord> Words)
{
    public string Text => string.Join(' ', Words.Select(w => w.Text));
    public IEnumerable<PdfWord> Between(double fromX, double toX) => Words.Where(w => w.Center >= fromX && w.Center < toX);
    public string TextBetween(double fromX, double toX) => string.Join(' ', Between(fromX, toX).Select(w => w.Text));
}

/// <summary>Reconstructs text rows from a PDF by grouping positioned words on the same baseline.</summary>
public partial class PdfLayout
{
    public IReadOnlyList<PdfLine> Lines { get; }
    public string FullText { get; }

    private PdfLayout(IReadOnlyList<PdfLine> lines)
    {
        Lines = lines;
        FullText = string.Join('\n', lines.Select(l => l.Text));
    }

    public static PdfLayout Load(Stream pdf, double tolerance = 2.5)
    {
        using var doc = PdfDocument.Open(pdf);
        var lines = new List<PdfLine>();
        foreach (Page page in doc.GetPages())
        {
            var words = page.GetWords()
                .Where(w => !string.IsNullOrWhiteSpace(w.Text))
                .Select(w => new PdfWord(w.Text, w.BoundingBox.Left, w.BoundingBox.Right, w.BoundingBox.Bottom, page.Number))
                .OrderByDescending(w => w.Bottom)
                .ToList();

            var current = new List<PdfWord>();
            double anchor = double.NaN;
            foreach (var w in words)
            {
                if (current.Count > 0 && Math.Abs(anchor - w.Bottom) > tolerance)
                {
                    lines.Add(new PdfLine(page.Number, anchor, current.OrderBy(x => x.Left).ToList()));
                    current = [];
                }
                if (current.Count == 0) anchor = w.Bottom;
                current.Add(w);
            }
            if (current.Count > 0)
                lines.Add(new PdfLine(page.Number, anchor, current.OrderBy(x => x.Left).ToList()));
        }
        return new PdfLayout(lines);
    }

    /// <summary>Finds the first number to the right of a label phrase on the same line (or just below it).</summary>
    public decimal? NumberRightOf(string label)
    {
        for (int i = 0; i < Lines.Count; i++)
        {
            var line = Lines[i];
            var idx = line.Text.IndexOf(label, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) continue;
            var labelWord = FindLabelEnd(line, label);
            if (labelWord == null) continue;
            var n = line.Words.Where(w => w.Left > labelWord.Right).Select(w => ParseDecimal(w.Text)).FirstOrDefault(v => v != null);
            if (n != null) return n;
        }
        return null;
    }

    public string? WordRightOf(string label, Func<string, bool>? accept = null)
    {
        foreach (var line in Lines)
        {
            var labelWord = FindLabelEnd(line, label);
            if (labelWord == null) continue;
            var w = line.Words.FirstOrDefault(x => x.Left > labelWord.Right && (accept?.Invoke(x.Text) ?? true));
            if (w != null) return w.Text;
        }
        return null;
    }

    private static PdfWord? FindLabelEnd(PdfLine line, string label)
    {
        var parts = label.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        for (int i = 0; i + parts.Length <= line.Words.Count; i++)
        {
            bool ok = true;
            for (int j = 0; j < parts.Length && ok; j++)
                ok = line.Words[i + j].Text.StartsWith(parts[j], StringComparison.OrdinalIgnoreCase);
            if (ok) return line.Words[i + parts.Length - 1];
        }
        return null;
    }

    public string? FirstMatch(Regex regex)
    {
        var m = regex.Match(FullText);
        return m.Success ? (m.Groups.Count > 1 ? m.Groups[1].Value : m.Value) : null;
    }

    public static decimal? ParseDecimal(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim().Replace("$", "").Replace(",", "");
        var neg = s.StartsWith('(') && s.EndsWith(')');
        s = s.Trim('(', ')');
        if (!NumberRegex().IsMatch(s)) return null;
        var v = decimal.Parse(s, CultureInfo.InvariantCulture);
        return neg ? -v : v;
    }

    [GeneratedRegex(@"^-?\d+(\.\d+)?$")]
    private static partial Regex NumberRegex();
}
