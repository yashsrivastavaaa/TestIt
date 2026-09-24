from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

Action = Literal["navigate", "click", "fill", "assertText", "wait", "setViewport"]

class RepositoryFile(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(max_length=12000)

class TestStep(BaseModel):
    action: Action
    selector: str | None = Field(default=None, max_length=300)
    value: str | None = Field(default=None, max_length=2000)

class PlannedTest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1, max_length=1200)
    type: str = Field(default="functional", max_length=40)
    priority: str = Field(default="", max_length=20)
    target_route: str = Field(default="", alias="targetRoute", max_length=500)
    target_files: list[str] = Field(default_factory=list, alias="targetFiles", max_length=20)
    expected_result: str = Field(default="", alias="expectedResult", max_length=1200)
    steps: list[TestStep] = Field(min_length=1, max_length=30)

class RepositorySourceRequest(BaseModel):
    clerk_user_id: str = Field(min_length=1, max_length=200)
    repository_id: int = Field(gt=0)
    repository_name: str = Field(min_length=1, max_length=300)
    repository_branch: str = Field(default="unknown", min_length=1, max_length=300)
    commit_sha: str = Field(min_length=1, max_length=100)
    change_summary: str = Field(max_length=12000)
    changed_files: list[str] = Field(default_factory=list, max_length=50)
    files: list[RepositoryFile] = Field(min_length=1, max_length=36)

class AnalyzeRequest(RepositorySourceRequest):
    pass

class GenerateTestsRequest(RepositorySourceRequest):
    application_url: str = Field(min_length=8, max_length=2000)
    feature_prompt: str = Field(default="", max_length=4000)
    test_case_count: int = Field(default=5, ge=1, le=10)

class AnalyzeResponse(BaseModel):
    indexed_chunks: int

class GenerateTestsResponse(BaseModel):
    test_cases: list[PlannedTest]

class RunRequest(BaseModel):
    clerk_user_id: str = Field(min_length=1, max_length=200)
    repository_id: int = Field(gt=0)
    application_url: str = Field(min_length=8, max_length=2000)
    use_browserbase: bool = False
    show_browser: bool = True
    test_case: PlannedTest

class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)

class AskRequest(BaseModel):
    clerk_user_id: str = Field(min_length=1, max_length=200)
    repository_id: int = Field(gt=0)
    question: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)

class WorkspaceChatRequest(BaseModel):
    clerk_user_id: str = Field(min_length=1, max_length=200)
    question: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)
