namespace SmAsia.Tests;

internal static class TestFiles
{
    public static string Path(string name)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(System.IO.Path.Combine(dir.FullName, "samples")))
            dir = dir.Parent;
        if (dir == null) throw new DirectoryNotFoundException("samples folder not found");
        return System.IO.Path.Combine(dir.FullName, "samples", name);
    }
}
