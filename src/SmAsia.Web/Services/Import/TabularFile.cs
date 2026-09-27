using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ClosedXML.Excel;

namespace SmAsia.Web.Services.Import;

/// <summary>A spreadsheet or CSV read into rows of text cells. Dates become yyyy-MM-dd; numbers use invariant culture.</summary>
public class TabularFile
{
    public List<string> SheetNames { get; private init; } = [];
    public string? Sheet { get; private init; }
    public List<string?[]> Rows { get; private init; } = [];
    public string Hash { get; private init; } = "";

    public static readonly string[] SupportedExtensions = [".csv", ".txt", ".tsv", ".xlsx", ".xlsm"];

    public static TabularFile Read(string path, string? sheet = null)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)));
        return ext is ".xlsx" or ".xlsm" ? ReadExcel(path, sheet, hash) : ReadDelimited(path, hash);
    }

    private static TabularFile ReadExcel(string path, string? sheet, string hash)
    {
        using var wb = new XLWorkbook(path);
        var names = wb.Worksheets.Select(w => w.Name).ToList();
        var ws = (sheet != null && wb.TryGetWorksheet(sheet, out var s) ? s : null) ?? wb.Worksheets.First();
        var rows = new List<string?[]>();
        var used = ws.RangeUsed();
        if (used != null)
        {
            int lastCol = used.LastColumn().ColumnNumber();
            foreach (var row in ws.Rows(1, used.LastRow().RowNumber()))
            {
                var cells = new string?[lastCol];
                for (int c = 1; c <= lastCol; c++) cells[c - 1] = CellText(row.Cell(c));
                rows.Add(cells);
            }
        }
        return new TabularFile { SheetNames = names, Sheet = ws.Name, Rows = rows, Hash = hash };
    }

    private static string? CellText(IXLCell cell)
    {
        try
        {
            if (cell.IsEmpty()) return null;
            var v = cell.Value;
            if (v.IsDateTime) return v.GetDateTime().ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            if (v.IsNumber) return v.GetNumber().ToString("0.##########", CultureInfo.InvariantCulture);
            if (v.IsBoolean) return v.GetBoolean() ? "TRUE" : "FALSE";
            if (v.IsError) return null;
            var t = v.ToString(CultureInfo.InvariantCulture).Trim();
            return t.Length == 0 ? null : t;
        }
        catch { return cell.GetString(); }
    }

    private static TabularFile ReadDelimited(string path, string hash)
    {
        var text = File.ReadAllText(path, Encoding.UTF8);
        var firstLine = text.Split('\n').FirstOrDefault(l => l.Trim().Length > 0) ?? "";
        char delimiter = new[] { ',', '\t', ';', '|' }.OrderByDescending(d => firstLine.Count(c => c == d)).First();
        return new TabularFile { Rows = ParseDelimited(text, delimiter), Hash = hash };
    }

    /// <summary>RFC 4180 style: quoted fields may contain delimiters, newlines and doubled quotes.</summary>
    public static List<string?[]> ParseDelimited(string text, char delimiter)
    {
        var rows = new List<string?[]>();
        var row = new List<string?>();
        var field = new StringBuilder();
        bool quoted = false;
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (quoted)
            {
                if (c == '"' && i + 1 < text.Length && text[i + 1] == '"') { field.Append('"'); i++; }
                else if (c == '"') quoted = false;
                else field.Append(c);
            }
            else if (c == '"' && field.Length == 0) quoted = true;
            else if (c == delimiter) { row.Add(Finish(field)); }
            else if (c == '\n' || c == '\r')
            {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
                row.Add(Finish(field));
                if (row.Any(x => x != null)) rows.Add(row.ToArray());
                row = [];
            }
            else field.Append(c);
        }
        row.Add(Finish(field));
        if (row.Any(x => x != null)) rows.Add(row.ToArray());
        return rows;

        static string? Finish(StringBuilder sb)
        {
            var s = sb.ToString().Trim();
            sb.Clear();
            return s.Length == 0 ? null : s;
        }
    }

    /// <summary>Guesses the header row: the first of the top 20 rows containing a field keyword.</summary>
    public int DetectHeaderRow(IEnumerable<string> keywords)
    {
        var keys = keywords.Select(k => k.ToLowerInvariant()).ToList();
        int best = 0, bestScore = -1;
        for (int r = 0; r < Math.Min(20, Rows.Count); r++)
        {
            var cells = Rows[r].Where(c => c != null).Select(c => c!.ToLowerInvariant()).ToList();
            var textCells = cells.Count(c => !decimal.TryParse(c, NumberStyles.Any, CultureInfo.InvariantCulture, out _));
            var score = cells.Count(c => keys.Any(c.Contains)) * 10 + textCells;
            if (score > bestScore && cells.Count >= 2) { best = r; bestScore = score; }
        }
        return best;
    }

    public string?[] Header(int headerRow) => headerRow < Rows.Count ? Rows[headerRow] : [];

    public static string HeaderSignature(string?[] header)
    {
        var joined = string.Join("|", header.Select(h => (h ?? "").Trim().ToLowerInvariant()));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(joined)))[..32];
    }

    public static decimal? ParseNumber(string? s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim().Replace("$", "").Replace(",", "").Replace(" ", "");
        var neg = s.StartsWith('(') && s.EndsWith(')');
        s = s.Trim('(', ')');
        if (s is "-" or "--") return null;
        return decimal.TryParse(s, NumberStyles.Number, CultureInfo.InvariantCulture, out var v) ? (neg ? -v : v) : null;
    }
}
