using DocxWorker;

namespace DocxWorker.Tests;

/// <summary>
/// Tests against real HEOR manuscripts in testdata/.
/// These tests verify that the write operations work correctly on real-world
/// documents with complex formatting, tables, and fragmented runs.
/// </summary>
public class RealManuscriptWriteTests : IDisposable
{
    private readonly string _outputDir;
    private readonly DocxReader _reader = new();
    private readonly DocxWriter _writer = new();

    // Absolute paths to test data files
    private static readonly string TestDataDir = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "testdata"));

    private static readonly string PfizerProtocol =
        Path.Combine(TestDataDir, "2025111625_Vx_2024_03_Pfizer FSME Sequelae_Protocol_v1.1_clean.docx");
    private static readonly string BayerProtocol =
        Path.Combine(TestDataDir, "A-24-18 Bayer Menopausal Symptoms_Study Protocol_v1.0.docx");
    private static readonly string BayerReport =
        Path.Combine(TestDataDir, "A-24-18 Bayer Menopausal Symptoms_Study Report_v0.3_Clean.docx");
    private static readonly string PfizerReport =
        Path.Combine(TestDataDir, "REP_Pfizer FSME Sequelae_v1.0.docx");

    public RealManuscriptWriteTests()
    {
        _outputDir = Path.Combine(Path.GetTempPath(), "docxworker-real-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(_outputDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_outputDir))
            Directory.Delete(_outputDir, recursive: true);
    }

    // ---- Pfizer FSME Protocol ----

    [Fact]
    public void PfizerProtocol_AddComment_OnKnownText()
    {
        var outputPath = Path.Combine(_outputDir, "pfizer-protocol-commented.docx");
        var originalContent = _reader.Read(PfizerProtocol);

        using (var session = _writer.Open(PfizerProtocol, outputPath))
        {
            session.AddCommentByText(
                "Tick-borne encephalitis (TBE) is a viral central nervous system (CNS) infection",
                "AI Reviewer",
                "Consider adding a more precise epidemiological definition here."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        // Comment was added
        Assert.Single(modifiedContent.Comments);
        Assert.Equal("AI Reviewer", modifiedContent.Comments[0].Author);
        Assert.Contains("Tick-borne encephalitis", modifiedContent.Comments[0].AnchorText);

        // Paragraph count preserved
        Assert.Equal(originalContent.Paragraphs.Count, modifiedContent.Paragraphs.Count);

        // Text content preserved
        for (int i = 0; i < originalContent.Paragraphs.Count; i++)
        {
            Assert.Equal(originalContent.Paragraphs[i].Text, modifiedContent.Paragraphs[i].Text);
        }
    }

    [Fact]
    public void PfizerProtocol_Validate()
    {
        var outputPath = Path.Combine(_outputDir, "pfizer-protocol-validate.docx");
        using var session = _writer.Open(PfizerProtocol, outputPath);
        var errors = session.Validate();

        // Real manuscripts may have validation issues from Word's own output.
        // We just report them and ensure the method doesn't crash.
        Assert.NotNull(errors);
        // Log for debugging: errors are expected from complex real-world docs
    }

    // ---- Bayer Menopausal Symptoms Protocol ----

    [Fact]
    public void BayerProtocol_AddComment_OnKnownText()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-protocol-commented.docx");
        var originalContent = _reader.Read(BayerProtocol);

        using (var session = _writer.Open(BayerProtocol, outputPath))
        {
            session.AddCommentByText(
                "Menopause marks the last spontaneous menstrual period",
                "AI Reviewer",
                "This definition should reference WHO or ICD-10 criteria."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        Assert.Single(modifiedContent.Comments);
        Assert.Contains("Menopause marks", modifiedContent.Comments[0].AnchorText);
        Assert.Equal(originalContent.Paragraphs.Count, modifiedContent.Paragraphs.Count);
    }

    [Fact]
    public void BayerProtocol_Validate()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-protocol-validate.docx");
        using var session = _writer.Open(BayerProtocol, outputPath);
        var errors = session.Validate();
        Assert.NotNull(errors);
    }

    // ---- Bayer Menopausal Symptoms Report ----

    [Fact]
    public void BayerReport_AddComment_OnKnownText()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-report-commented.docx");
        var originalContent = _reader.Read(BayerReport);

        using (var session = _writer.Open(BayerReport, outputPath))
        {
            session.AddCommentByText(
                "Common menopausal symptoms include vasomotor symptoms",
                "AI Reviewer",
                "Please quantify the prevalence of these symptoms."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        Assert.Single(modifiedContent.Comments);
        Assert.Contains("Common menopausal symptoms", modifiedContent.Comments[0].AnchorText);
        Assert.Equal(originalContent.Paragraphs.Count, modifiedContent.Paragraphs.Count);
    }

    [Fact]
    public void BayerReport_AddComment_PreservesTextContent()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-report-preserve.docx");
        var originalContent = _reader.Read(BayerReport);

        using (var session = _writer.Open(BayerReport, outputPath))
        {
            session.AddCommentByText(
                "retrospective observational study",
                "AI Reviewer",
                "Good study design choice."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        // Verify all paragraph text is preserved
        for (int i = 0; i < originalContent.Paragraphs.Count; i++)
        {
            Assert.Equal(originalContent.Paragraphs[i].Text, modifiedContent.Paragraphs[i].Text);
        }
    }

    [Fact]
    public void BayerReport_Validate()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-report-validate.docx");
        using var session = _writer.Open(BayerReport, outputPath);
        var errors = session.Validate();
        Assert.NotNull(errors);
    }

    // ---- Pfizer FSME Report ----

    [Fact]
    public void PfizerReport_AddComment_OnKnownText()
    {
        var outputPath = Path.Combine(_outputDir, "pfizer-report-commented.docx");
        var originalContent = _reader.Read(PfizerReport);

        using (var session = _writer.Open(PfizerReport, outputPath))
        {
            session.AddCommentByText(
                "the present study aimed to fill a critical evidence gap",
                "AI Reviewer",
                "Strong motivation statement. Consider expanding on what makes this gap critical."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        Assert.Single(modifiedContent.Comments);
        Assert.Contains("present study aimed", modifiedContent.Comments[0].AnchorText);
        Assert.Equal(originalContent.Paragraphs.Count, modifiedContent.Paragraphs.Count);
    }

    [Fact]
    public void PfizerReport_AddComment_PreservesTextContent()
    {
        var outputPath = Path.Combine(_outputDir, "pfizer-report-preserve.docx");
        var originalContent = _reader.Read(PfizerReport);

        using (var session = _writer.Open(PfizerReport, outputPath))
        {
            session.AddCommentByText(
                "What is the comprehensive, long-term burden of TBE in Germany?",
                "AI Reviewer",
                "Clear research question."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);

        for (int i = 0; i < originalContent.Paragraphs.Count; i++)
        {
            Assert.Equal(originalContent.Paragraphs[i].Text, modifiedContent.Paragraphs[i].Text);
        }
    }

    [Fact]
    public void PfizerReport_Validate()
    {
        var outputPath = Path.Combine(_outputDir, "pfizer-report-validate.docx");
        using var session = _writer.Open(PfizerReport, outputPath);
        var errors = session.Validate();
        Assert.NotNull(errors);
    }

    // ---- Cross-cutting: comment near tables ----

    [Fact]
    public void PfizerProtocol_AddComment_NearTable()
    {
        // The Pfizer protocol has 11 tables. Find text near a table and comment on it.
        var outputPath = Path.Combine(_outputDir, "pfizer-near-table.docx");
        var originalContent = _reader.Read(PfizerProtocol);

        // "The study objectives, along with the respective operationalization" is near a table
        using (var session = _writer.Open(PfizerProtocol, outputPath))
        {
            session.AddCommentByText(
                "The study objectives, along with the respective operationalization",
                "AI Reviewer",
                "This section should cross-reference the methods section."
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);
        Assert.Single(modifiedContent.Comments);
        // Tables should still be intact
        Assert.Equal(originalContent.Tables.Count, modifiedContent.Tables.Count);
    }

    [Fact]
    public void BayerProtocol_AddComment_NearTable()
    {
        var outputPath = Path.Combine(_outputDir, "bayer-near-table.docx");
        var originalContent = _reader.Read(BayerProtocol);

        // "Table 2 presents planned milestones" is right before a table
        using (var session = _writer.Open(BayerProtocol, outputPath))
        {
            session.AddCommentByText(
                "planned milestones for this study",
                "AI Reviewer",
                "Are these milestones realistic given the data availability?"
            );
            session.Save();
        }

        var modifiedContent = _reader.Read(outputPath);
        Assert.Single(modifiedContent.Comments);
        Assert.Equal(originalContent.Tables.Count, modifiedContent.Tables.Count);
    }
}
