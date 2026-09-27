namespace SmAsia.Web.Services.Import;

/// <summary>Keeps uploaded files between the upload, mapping and commit steps of an import.</summary>
public class UploadStore
{
    private readonly string _dir;

    public UploadStore(IWebHostEnvironment env)
    {
        _dir = Path.Combine(env.ContentRootPath, "App_Data", "uploads");
        Directory.CreateDirectory(_dir);
        foreach (var f in Directory.EnumerateFiles(_dir).Where(f => File.GetCreationTimeUtc(f) < DateTime.UtcNow.AddDays(-3)))
            try { File.Delete(f); } catch { /* in use; try next time */ }
    }

    public async Task<string> SaveAsync(IFormFile file)
    {
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        var token = $"{Guid.NewGuid():N}{ext}";
        await using var fs = File.Create(Path.Combine(_dir, token));
        await file.CopyToAsync(fs);
        // Remember the original name next to the upload.
        await File.WriteAllTextAsync(Path.Combine(_dir, token + ".name"), Path.GetFileName(file.FileName));
        return token;
    }

    public string? PathFor(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || token.Contains("..")) return null;
        var path = Path.Combine(_dir, token);
        return File.Exists(path) ? path : null;
    }

    public string OriginalName(string token)
    {
        var p = Path.Combine(_dir, token + ".name");
        return File.Exists(p) ? File.ReadAllText(p) : token;
    }
}
