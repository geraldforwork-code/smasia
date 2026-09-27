using SmAsia.Web.Services.Import;

namespace SmAsia.Web.Pages.Import;

/// <summary>Everything the shared column-mapping partial needs to render.</summary>
public class MappingView
{
    public required TabularFile File { get; init; }
    public required string Token { get; init; }
    public required string OriginalName { get; init; }
    public int HeaderRow { get; init; }
    public required ImportField[] Fields { get; init; }
    public required Dictionary<string, int> Map { get; init; }
    public bool FromSavedProfile { get; init; }

    public string?[] Header => File.Header(HeaderRow);
    public int ColumnCount => File.Rows.Skip(HeaderRow).Take(30).Select(r => r.Length).DefaultIfEmpty(0).Max();

    public string ColumnLabel(int i)
    {
        var name = i < Header.Length ? Header[i] : null;
        var letter = i < 26 ? ((char)('A' + i)).ToString() : $"{(char)('A' + i / 26 - 1)}{(char)('A' + i % 26)}";
        return string.IsNullOrWhiteSpace(name) ? $"Column {letter}" : $"{letter}: {name}";
    }

    public static Dictionary<string, int> Clean(Dictionary<string, int>? map) =>
        (map ?? new()).Where(kv => kv.Value >= 0).ToDictionary(kv => kv.Key, kv => kv.Value);
}
