import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy, 
  Timestamp,
  serverTimestamp,
  increment,
  limit,
  startAfter,
  FieldValue,
  setDoc,
  getFirestore
} from 'firebase/firestore';
import { db, searchDb, getSearchDb } from './config';
import { calculateArticleScore } from '../utils/articleScoreCalculator';
import { cacheManager } from '../utils/cacheManager'; // cacheManagerをインポート
import { withCache } from '../utils/cacheManager';

// Wiki記事の型定義 - メインDBに保存する完全な記事情報
export interface WikiArticle {
  id?: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  author: string;
  authorId: string;
  imageUrl?: string;
  imageId?: string;
  date: Timestamp | string;
  lastUpdated?: Timestamp | FieldValue;
  usefulCount: number;
  likeCount: number;
  dislikeCount?: number; // 管理者のみが見える低評価カウント
  deleteUrl?: string;
  articleScore?: number; // 記事の評価スコアを追加
}

// 検索用DB用の記事概要型定義
export interface ArticleSummary {
  id: string;
  title: string;
  description: string;
  tags: string[];
  author: string;
  authorId: string;
  imageUrl?: string;
  date: Timestamp | string;
  lastUpdated?: Timestamp | FieldValue;
  usefulCount: number;
  likeCount: number;
  dislikeCount?: number;
  articleScore?: number; // 記事スコアを追加
}

// コメントの型定義を修正
export interface WikiComment {
  id?: string;
  content: string;
  author: string | null;
  authorId: string | null;
  date: Timestamp | string | FieldValue;
  replyCount?: number;
  likeCount?: number;
}

// 返信コメントの型定義を追加
export interface WikiReply extends WikiComment {
  parentId: string;
}

// タグの型定義を追加
export interface Tag {
  name: string;
  count: number;
  lastUsed: Timestamp | FieldValue;
}

// 記事コレクションへの参照（メインDB）
const articlesRef = collection(db, 'wikiArticles');

// 記事概要コレクションへの参照（検索用DB）
const articleSummariesRef = collection(searchDb, 'articleSummaries');

// タグコレクションへの参照（検索用DB）
const tagsRef = collection(searchDb, 'tags');

/**
 * 記事IDから記事データを取得する
 * @param id 記事ID
 * @returns 記事データ
 */
export async function getArticleById(id: string): Promise<WikiArticle | null> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      const mainData = { id: docSnap.id, ...docSnap.data() } as WikiArticle;
      
      // 評価データを検索DBから取得して補完
      try {
        const summaryRef = doc(searchDb, 'articleSummaries', id);
        const summarySnap = await getDoc(summaryRef);
        
        if (summarySnap.exists()) {
          const summaryData = summarySnap.data();
          // 評価関連データを検索DBから取得
          mainData.likeCount = summaryData.likeCount || 0;
          mainData.usefulCount = summaryData.usefulCount || 0;
          mainData.dislikeCount = summaryData.dislikeCount || 0;
          mainData.articleScore = summaryData.articleScore || 0;
        }
      } catch (error) {
        console.warn('検索DB補完エラー:', error);
      }
      
      return mainData;
    }
    
    return null;
  } catch (error) {
    console.error('記事取得エラー:', error);
    throw error;
  }
}

/**
 * すべての記事概要を取得する（検索用DB）
 * @param sortField ソートフィールド
 * @returns 記事概要一覧
 */
export async function getAllArticleSummaries(sortField: string = 'usefulCount'): Promise<ArticleSummary[]> {
  try {
    const q = query(articleSummariesRef, orderBy(sortField, 'desc'));
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as ArticleSummary[];
  } catch (error) {
    console.error('記事概要一覧取得エラー:', error);
    throw error;
  }
}

/**
 * すべての記事を取得する
 * @param sortField ソートフィールド
 * @returns 記事一覧
 */
export async function getAllArticles(sortField: string = 'usefulCount'): Promise<WikiArticle[]> {
  try {
    // 記事概要一覧を検索用DBから取得
    const summaries = await getAllArticleSummaries(sortField);
    const articleIds = summaries.map(summary => summary.id);
    
    // 完全な記事データをメインDBから取得
    const articles: WikiArticle[] = [];
    
    for (const id of articleIds) {
      const article = await getArticleById(id);
      if (article) {
        articles.push(article);
      }
    }
    
    return articles;
  } catch (error) {
    console.error('記事一覧取得エラー:', error);
    throw error;
  }
}

/**
 * タグで記事をフィルタリングする（検索用DBを使用）
 * @param tags タグ配列
 * @returns フィルタリングされた記事一覧
 */
export async function getArticlesByTags(tags: string[]): Promise<ArticleSummary[]> {
  try {
    if (!tags.length) return getAllArticleSummaries();
    
    // Firestoreは配列に対する「すべての要素を含む」クエリをサポートしていないため
    // 最初のタグでフィルタリングした後、クライアント側でさらにフィルタリング
    const q = query(articleSummariesRef, where('tags', 'array-contains', tags[0]));
    const querySnapshot = await getDocs(q);
    
    const articles = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as ArticleSummary[];
    
    // 残りのタグでフィルタリング
    if (tags.length > 1) {
      return articles.filter(article => 
        tags.every(tag => article.tags.includes(tag))
      );
    }
    
    return articles;
  } catch (error) {
    console.error('タグによる記事取得エラー:', error);
    throw error;
  }
}

/**
 * 新しい記事を追加する（両方のDBに追加）
 * @param article 記事データ
 * @returns 追加された記事のID
 */
export async function createArticle(article: Omit<WikiArticle, 'id'>): Promise<string> {
  try {
    const now = serverTimestamp();
    let id: string;
    
    // 記事スコアを計算
    const articleScore = calculateArticleScore(
      article.content,
      article.likeCount || 0,
      article.usefulCount || 0,
      article.dislikeCount || 0
    );
    
    // メインDB用のデータから評価関連データを除外
    const mainDbArticle = { ...article };
    delete (mainDbArticle as any).usefulCount;
    delete (mainDbArticle as any).likeCount;
    delete (mainDbArticle as any).dislikeCount;
    delete (mainDbArticle as any).articleScore;
    
    // 1. メインDBに完全な記事データを保存（評価関連データを除く）
    try {
      console.log("メインDBに記事を保存中...");
      const docRef = await addDoc(articlesRef, {
        ...mainDbArticle,
        date: article.date || now,
        lastUpdated: now,
        content: article.content
      });
      id = docRef.id;
      console.log("メインDBへの保存完了。ID:", id);
    } catch (mainDbError) {
      console.error("メインDB保存エラー:", mainDbError);
      throw new Error(`メインDBへの書き込みに失敗しました: ${mainDbError instanceof Error ? mainDbError.message : 'Unknown error'}`);
    }
    
    // 2. 検索用DBに記事の概要を保存（認証なしでアクセス可能）
    try {
      console.log("検索用DBに記事概要を保存中...");
      const summaryRef = doc(searchDb, 'articleSummaries', id);
      await setDoc(summaryRef, {
        id,
        title: article.title,
        description: article.description,
        tags: article.tags,
        author: article.author,
        authorId: article.authorId,
        imageUrl: article.imageUrl,
        date: article.date || now,
        lastUpdated: now,
        usefulCount: article.usefulCount || 0,
        likeCount: article.likeCount || 0,
        dislikeCount: article.dislikeCount || 0,
        articleScore // 記事スコアを追加
      });
      console.log("検索用DBへの保存完了");
      
      // 3. 著者のスコア情報を更新
      await updateAuthorScoreOnArticleCreate(article.authorId, articleScore);
    } catch (searchDbError) {
      console.error("検索用DB保存エラー:", searchDbError);
      
      // 検索用DBへの保存に失敗した場合、メインDBの記事を削除して整合性を保つ
      try {
        console.warn("メインDBからの記事を削除して整合性を保ちます...");
        await deleteDoc(doc(db, 'wikiArticles', id));
        console.warn("メインDBからの記事削除完了");
      } catch (cleanupError) {
        console.error("メインDB清掃エラー:", cleanupError);
      }
      
      throw new Error(`検索用DBへの書き込みに失敗しました: ${searchDbError instanceof Error ? searchDbError.message : 'Unknown error'}`);
    }
    
    return id;
  } catch (error) {
    console.error('記事作成エラー:', error);
    throw error;
  }
}

/**
 * 記事を更新する（両方のDBを更新）
 * @param id 記事ID
 * @param updateData 更新内容
 */
export async function updateArticle(id: string, updateData: Partial<WikiArticle>): Promise<void> {
  try {
    const now = serverTimestamp();
    
    // 最新の記事全体を取得
    const article = await getArticleById(id);
    if (!article) {
      throw new Error("記事が見つかりません");
    }
    
    // searchDBから最新の評価データを取得
    const summaryRef = doc(searchDb, 'articleSummaries', id);
    const summarySnap = await getDoc(summaryRef);
    const summaryData = summarySnap.exists() ? summarySnap.data() : null;
    
    // 最新の評価データを使用
    const currentLikes = summaryData?.likeCount || 0;
    const currentUseful = summaryData?.usefulCount || 0;
    const currentDislikes = summaryData?.dislikeCount || 0;
    
    // 更新されるデータを含めた記事内容でスコアを再計算
    const updatedContent = updateData.content || article.content;
    const articleScore = calculateArticleScore(
      updatedContent,
      currentLikes,
      currentUseful,
      currentDislikes
    );
    
    // メインDB更新用データを作成（評価カウントとスコアは除外）
    const mainDbUpdateData: Partial<WikiArticle> = { 
      ...updateData, 
      lastUpdated: now
    };
    
    // 評価関連データはメインDBから削除
    delete (mainDbUpdateData as any).usefulCount;
    delete (mainDbUpdateData as any).likeCount;
    delete (mainDbUpdateData as any).dislikeCount;
    delete (mainDbUpdateData as any).articleScore;
    
    // 1. メインDBの記事を更新
    const docRef = doc(db, 'wikiArticles', id);
    await updateDoc(docRef, mainDbUpdateData);
    
    // 2. 検索用DBの記事概要も更新（関連フィールドのみ）
    const summaryUpdateData: Partial<ArticleSummary> = { 
      lastUpdated: now,
      articleScore // 更新されたスコアを追加
    };
    
    // 検索用DBに関連するフィールドだけを抽出
    const relevantFields: (keyof ArticleSummary)[] = [
      'title', 'description', 'tags', 'author', 'imageUrl'
    ];
    
    relevantFields.forEach(field => {
      if (field in updateData) {
        summaryUpdateData[field] = updateData[field as keyof WikiArticle] as any;
      }
    });
    
    if (Object.keys(summaryUpdateData).length > 1) { // lastUpdated以外にも更新するフィールドがある場合
      await updateDoc(summaryRef, summaryUpdateData);
    }
    
    // 著者スコアを更新
    if (article.authorId) {
      await updateAuthorScore(article.authorId, id, articleScore);
    }
  } catch (error) {
    console.error('記事更新エラー:', error);
    throw error;
  }
}

/**
 * 記事を削除する（両方のDBから削除）
 * @param id 記事ID
 */
export async function deleteArticle(id: string): Promise<void> {
  try {
    // 1. メインDBから記事を削除（認証済みユーザーによるアクセスが保証される）
    const docRef = doc(db, 'wikiArticles', id);
    await deleteDoc(docRef);
    
    // 2. 検索用DBからも記事概要を削除
    try {
      const summaryRef = doc(searchDb, 'articleSummaries', id);
      await deleteDoc(summaryRef);
    } catch (searchDbError) {
      console.error('検索用DB削除エラー:', searchDbError);
      // エラーはログに残すが、メインDBからは削除済みなので中断しない
    }
  } catch (error) {
    console.error('記事削除エラー:', error);
    throw error;
  }
}

/**
 * ユーザーが書いた記事の概要を取得する（検索用DB）
 * @param authorId 著者ID
 * @returns ユーザーの記事概要一覧
 */
export async function getUserArticleSummaries(authorId: string): Promise<ArticleSummary[]> {
  try {
    // インデックスが必要なクエリ
    const q = query(
      articleSummariesRef,
      where('authorId', '==', authorId),
      orderBy('date', 'desc')
    );
    
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as ArticleSummary[];
  } catch (error) {
    console.error('ユーザー記事概要取得エラー:', error);
    
    // 開発環境では、インデックスエラーを特定してガイダンスを表示
    if (error instanceof Error && error.toString().includes('requires an index')) {
      console.warn(
        'Firestoreインデックスが必要です。以下のリンクからインデックスを作成してください:',
        'https://console.firebase.google.com/project/evasio-nova/firestore/indexes'
      );
    }
    
    return [];
  }
}

/**
 * ユーザーが書いた記事（完全なデータ）を取得する
 * @param authorId 著者ID
 * @returns ユーザーの記事一覧
 */
export async function getUserArticles(authorId: string): Promise<WikiArticle[]> {
  try {
    // 概要情報を検索用DBから取得
    const summaries = await getUserArticleSummaries(authorId);
    
    // 完全な記事データをメインDBから取得
    const articles: WikiArticle[] = [];
    
    for (const summary of summaries) {
      const article = await getArticleById(summary.id);
      if (article) {
        articles.push(article);
      }
    }
    
    return articles;
  } catch (error) {
    console.error('ユーザー記事取得エラー:', error);
    return [];
  }
}

/**
 * 「使えた！」カウントを増やす（検索用DBのみ更新）
 * @param id 記事ID
 */
export async function incrementUsefulCount(id: string): Promise<void> {
  try {
    // 記事の著者IDを取得
    const article = await getArticleById(id);
    if (!article?.authorId) throw new Error('Article or author not found');
    const authorId = article.authorId;

    // 検索用DBの記事概要を更新
    const articleSummaryRef = doc(searchDb, 'articleSummaries', id);
    
    // 記事データを取得しスコアを再計算
    if (article) {
      const newUsefulCount = (article.usefulCount || 0) + 1;
      const newScore = calculateArticleScore(
        article.content,
        article.likeCount,
        newUsefulCount,
        article.dislikeCount || 0
      );
      
      // スコアも一緒に更新（searchDBのみ）
      await updateDoc(articleSummaryRef, {
        usefulCount: increment(1),
        articleScore: newScore
      });
      
      // 著者スコアを更新
      await updateAuthorScore(authorId, id, newScore);
      
      // キャッシュも更新（もし存在すれば）
      try {
        await cacheManager.updateArticleCount(
          id, 
          article.likeCount, 
          newUsefulCount,
          newScore
        );
      } catch (cacheError) {
        console.warn("キャッシュの更新に失敗:", cacheError);
      }
    } else {
      // 記事が見つからない場合は通常通り更新
      await updateDoc(articleSummaryRef, {
        usefulCount: increment(1)
      });
    }
    
    // 検索用DBのcountsコレクションを更新
    const countsRef = doc(searchDb, 'counts', 'article');
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    
    // 先に現在のカウントドキュメントを取得
    const [countsDoc, authorCountsDoc] = await Promise.all([
      getDoc(countsRef),
      getDoc(authorCountsRef)
    ]);

    // 記事ごとのカウント更新
    if (countsDoc.exists()) {
      // 既存のデータを更新
      const countsData = countsDoc.data();
      const currentCounts = countsData.counts || {};
      const articleCounts = currentCounts[id] || { likeCount: 0, usefulCount: 0 };
      
      currentCounts[id] = {
        ...articleCounts,
        usefulCount: articleCounts.usefulCount + 1
      };
      
      await setDoc(countsRef, { 
        counts: currentCounts,
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      }, { merge: true });
    } else {
      // 新規作成
      const articleData = await getArticleById(id);
      const newCount = articleData?.usefulCount ? (articleData.usefulCount + 1) : 1;
      const likeCount = articleData?.likeCount || 0;
      
      await setDoc(countsRef, { 
        counts: { 
          [id]: { 
            likeCount, 
            usefulCount: newCount 
          } 
        },
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      });
    }

    // 著者ごとのカウント更新
    if (authorCountsDoc.exists()) {
      const authorData = authorCountsDoc.data();
      const authorCounts = authorData.counts || {};
      const currentAuthorCount = authorCounts[authorId] || { 
        likeCount: 0, 
        usefulCount: 0,
        articleScoreSum: 0,
        articleCount: 0
      };

      // 記事のスコアを取得
      const articleSummary = await getDoc(articleSummaryRef);
      const articleScore = articleSummary.exists() ? (articleSummary.data().articleScore || 0) : 0;

      authorCounts[authorId] = {
        ...currentAuthorCount,
        usefulCount: currentAuthorCount.usefulCount + 1,
        // スコアは変わらないのでそのまま
      };

      await setDoc(authorCountsRef, {
        counts: authorCounts,
        lastUpdated: Date.now()
      }, { merge: true });
    } else {
      // スコアの初期設定
      const articleSummary = await getDoc(articleSummaryRef);
      const articleScore = articleSummary.exists() ? (articleSummary.data().articleScore || 0) : 0;

      await setDoc(authorCountsRef, {
        counts: {
          [authorId]: { 
            likeCount: 0, 
            usefulCount: 1,
            articleScoreSum: articleScore,
            articleCount: 1
          }
        },
        lastUpdated: Date.now()
      });
    }

    // キャッシュをクリア
    import('../utils/cacheManager').then(cache => {
      cache.deleteCache(`article-counts:["${id}"]`);
    });
  } catch (error) {
    console.error('役に立ったカウント更新エラー:', error);
    throw error;
  }
}

/**
 * 「いいね」カウントを増やす（検索用DBのみ更新）
 * @param id 記事ID
 */
export async function incrementLikeCount(id: string): Promise<void> {
  try {
    // 記事の著者IDを取得
    const article = await getArticleById(id);
    if (!article?.authorId) throw new Error('Article or author not found');
    const authorId = article.authorId;

    // 検索用DBの記事概要を更新
    const articleSummaryRef = doc(searchDb, 'articleSummaries', id);
    
    // 記事データを取得しスコアを再計算
    if (article) {
      const newLikeCount = (article.likeCount || 0) + 1;
      const newScore = calculateArticleScore(
        article.content,
        newLikeCount,
        article.usefulCount,
        article.dislikeCount || 0
      );
      
      // スコアも一緒に更新（searchDBのみ）
      await updateDoc(articleSummaryRef, {
        likeCount: increment(1),
        articleScore: newScore
      });
      
      // 著者スコアを更新
      await updateAuthorScore(authorId, id, newScore);
      
      // キャッシュも更新（もし存在すれば）
      try {
        await cacheManager.updateArticleCount(
          id, 
          newLikeCount, 
          article.usefulCount,
          newScore
        );
      } catch (cacheError) {
        console.warn("キャッシュの更新に失敗:", cacheError);
      }
    } else {
      // 記事が見つからない場合は通常通り更新
      await updateDoc(articleSummaryRef, {
        likeCount: increment(1)
      });
    }
    
    // 検索用DBのcountsコレクションを更新
    const countsRef = doc(searchDb, 'counts', 'article');
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    
    // 先に現在のカウントドキュメントを取得
    const [countsDoc, authorCountsDoc] = await Promise.all([
      getDoc(countsRef),
      getDoc(authorCountsRef)
    ]);

    // 記事ごとのカウント更新
    if (countsDoc.exists()) {
      // 既存のデータを更新
      const countsData = countsDoc.data();
      const currentCounts = countsData.counts || {};
      const articleCounts = currentCounts[id] || { likeCount: 0, usefulCount: 0 };
      
      currentCounts[id] = {
        ...articleCounts,
        likeCount: articleCounts.likeCount + 1
      };
      
      await setDoc(countsRef, { 
        counts: currentCounts,
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      }, { merge: true });
    } else {
      // 新規作成
      const articleData = await getArticleById(id);
      const newCount = articleData?.likeCount ? (articleData.likeCount + 1) : 1;
      const usefulCount = articleData?.usefulCount || 0;
      
      await setDoc(countsRef, { 
        counts: { 
          [id]: { 
            likeCount: newCount, 
            usefulCount 
          } 
        },
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      });
    }

    // 著者ごとのカウント更新
    if (authorCountsDoc.exists()) {
      const authorData = authorCountsDoc.data();
      const authorCounts = authorData.counts || {};
      const currentAuthorCount = authorCounts[authorId] || { 
        likeCount: 0, 
        usefulCount: 0,
        articleScoreSum: 0,
        articleCount: 0 
      };

      // 記事のスコアを取得
      const articleSummary = await getDoc(articleSummaryRef);
      const articleScore = articleSummary.exists() ? (articleSummary.data().articleScore || 0) : 0;

      authorCounts[authorId] = {
        ...currentAuthorCount,
        likeCount: currentAuthorCount.likeCount + 1,
        // スコアは変わらないのでそのまま
      };

      await setDoc(authorCountsRef, {
        counts: authorCounts,
        lastUpdated: Date.now()
      }, { merge: true });
    } else {
      // スコアの初期設定
      const articleSummary = await getDoc(articleSummaryRef);
      const articleScore = articleSummary.exists() ? (articleSummary.data().articleScore || 0) : 0;

      await setDoc(authorCountsRef, {
        counts: {
          [authorId]: { 
            likeCount: 1, 
            usefulCount: 0,
            articleScoreSum: articleScore,
            articleCount: 1
          }
        },
        lastUpdated: Date.now()
      });
    }

    // キャッシュをクリア
    import('../utils/cacheManager').then(cache => {
      cache.deleteCache(`article-counts:["${id}"]`);
    });
  } catch (error) {
    console.error('いいねカウント更新エラー:', error);
    throw error;
  }
}

/**
 * 「低評価」カウントを増やす（検索用DBのみ更新）- 管理者のみが使用
 * @param id 記事ID
 * @param isAdmin 管理者かどうか
 */
export async function incrementDislikeCount(id: string, isAdmin: boolean = false): Promise<void> {
  try {
    // 管理者チェック（アプリケーションコードでの権限管理）
    if (!isAdmin) {
      throw new Error('管理者権限がありません');
    }
    
    // 記事データを取得しスコアを再計算
    const article = await getArticleById(id);
    if (!article?.authorId) throw new Error('Article or author not found');
    const authorId = article.authorId;
    
    const articleSummaryRef = doc(searchDb, 'articleSummaries', id);
    
    if (article) {
      const newDislikeCount = (article.dislikeCount || 0) + 1;
      const newScore = calculateArticleScore(
        article.content,
        article.likeCount,
        article.usefulCount,
        newDislikeCount
      );
      
      // スコアも一緒に更新（searchDBのみ）
      await updateDoc(articleSummaryRef, {
        dislikeCount: increment(1),
        articleScore: newScore
      });
      
      // 著者スコアを更新
      await updateAuthorScore(authorId, id, newScore);
      
      // メインDBは更新しない
    } else {
      // 記事が見つからない場合は通常通り更新
      await updateDoc(articleSummaryRef, {
        dislikeCount: increment(1)
      });
    }
    
    // 検索用DBのcountsコレクションを更新
    const countsRef = doc(searchDb, 'counts', 'article');
    const countsDoc = await getDoc(countsRef);

    if (countsDoc.exists()) {
      // 既存のデータを更新
      const countsData = countsDoc.data();
      const currentCounts = countsData.counts || {};
      const articleCounts = currentCounts[id] || { likeCount: 0, usefulCount: 0, dislikeCount: 0 };
      
      currentCounts[id] = {
        ...articleCounts,
        dislikeCount: (articleCounts.dislikeCount || 0) + 1
      };
      
      await setDoc(countsRef, { 
        counts: currentCounts,
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      }, { merge: true });
    } else {
      // 新規作成
      const articleData = await getArticleById(id);
      const likeCount = articleData?.likeCount || 0;
      const usefulCount = articleData?.usefulCount || 0;
      
      await setDoc(countsRef, { 
        counts: { 
          [id]: { 
            likeCount, 
            usefulCount,
            dislikeCount: 1
          } 
        },
        lastUpdated: Date.now() // キャッシュ有効期限の起点
      });
    }

    // キャッシュをクリア
    import('../utils/cacheManager').then(cache => {
      cache.deleteCache(`article-counts:["${id}"]`);
    });
  } catch (error) {
    console.error('低評価カウント更新エラー:', error);
    throw error;
  }
}

/**
 * 記事の評価カウントを取得する（検索用DB）
 * @param id 記事ID
 * @returns {usefulCount, likeCount} 形式のオブジェクト
 */
export async function getArticleRatings(id: string): Promise<{usefulCount: number, likeCount: number}> {
  try {
    const summaryRef = doc(searchDb, 'articleSummaries', id);
    const docSnap = await getDoc(summaryRef);
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      return {
        usefulCount: data.usefulCount || 0,
        likeCount: data.likeCount || 0
      };
    }
    
    return {
      usefulCount: 0,
      likeCount: 0
    };
  } catch (error) {
    console.error('記事評価取得エラー:', error);
    return {
      usefulCount: 0,
      likeCount: 0
    };
  }
}

/**
 * 記事のコメントを取得する（メインDBから）
 * @param articleId 記事ID
 * @param lastComment 前回の最後のコメント（ページネーション用）
 * @param itemsPerPage 1ページあたりのコメント数
 * @returns コメント一覧
 */
export async function getArticleComments(
  articleId: string, 
  lastComment: WikiComment | null = null, 
  itemsPerPage: number = 10
): Promise<WikiComment[]> {
  try {
    // 記事のサブコレクションとしてのコメントを取得
    const commentsRef = collection(db, 'wikiArticles', articleId, 'comments');
    
    let q = query(
      commentsRef,
      orderBy('date', 'desc'),
      limit(itemsPerPage)
    );
    
    // ページネーション: 前回の最後のコメント以降を取得
    if (lastComment) {
      q = query(
        commentsRef,
        orderBy('date', 'desc'),
        startAfter(lastComment.date),
        limit(itemsPerPage)
      );
    }
    
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as WikiComment[];
  } catch (error) {
    console.error('コメント取得エラー:', error);
    throw error;
  }
}

/**
 * コメントの返信を取得する
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param lastReply 前回の最後の返信（ページネーション用）
 * @param itemsPerPage 1ページあたりの返信数
 * @returns 返信一覧
 */
export async function getCommentReplies(
  articleId: string,
  commentId: string, 
  lastReply: WikiReply | null = null, 
  itemsPerPage: number = 5
): Promise<WikiReply[]> {
  try {
    // コメントのサブコレクションとしての返信を取得
    const repliesRef = collection(db, 'wikiArticles', articleId, 'comments', commentId, 'replies');
    
    let q = query(
      repliesRef,
      orderBy('date', 'asc'),
      limit(itemsPerPage)
    );
    
    if (lastReply) {
      q = query(
        repliesRef,
        orderBy('date', 'asc'),
        startAfter(lastReply.date),
        limit(itemsPerPage)
      );
    }
    
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      parentId: commentId,
      ...doc.data()
    })) as WikiReply[];
  } catch (error) {
    console.error('返信取得エラー:', error);
    throw error;
  }
}

/**
 * 新しいコメントを追加する
 * @param articleId 記事ID
 * @param comment コメントデータ
 * @returns 追加されたコメントのID
 */
export async function addComment(
  articleId: string,
  comment: Omit<WikiComment, 'id'>
): Promise<string> {
  try {
    const commentsRef = collection(db, 'wikiArticles', articleId, 'comments');
    const docRef = await addDoc(commentsRef, {
      ...comment,
      date: serverTimestamp(),
      replyCount: 0,
      likeCount: 0
    });
    
    return docRef.id;
  } catch (error) {
    console.error('コメント追加エラー:', error);
    throw error;
  }
}

/**
 * 返信コメントを追加する
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param reply 返信データ
 * @returns 追加された返信のID
 */
export async function addReply(
  articleId: string,
  commentId: string,
  reply: Omit<WikiReply, 'id' | 'parentId'>
): Promise<string> {
  try {
    // トランザクションを使用して、返信の追加と親コメントの返信数更新を一括処理
    const repliesRef = collection(db, 'wikiArticles', articleId, 'comments', commentId, 'replies');
    const commentRef = doc(db, 'wikiArticles', articleId, 'comments', commentId);
    
    const docRef = await addDoc(repliesRef, {
      ...reply,
      date: serverTimestamp(),
      likeCount: 0
    });
    
    // 親コメントの返信カウントを増やす
    await updateDoc(commentRef, {
      replyCount: increment(1)
    });
    
    return docRef.id;
  } catch (error) {
    console.error('返信追加エラー:', error);
    throw error;
  }
}

/**
 * コメントのいいねカウントを増やす
 * @param articleId 記事ID
 * @param commentId コメントID
 * @returns 更新処理のPromise
 */
export async function incrementCommentLikeCount(
  articleId: string,
  commentId: string
): Promise<void> {
  try {
    const commentRef = doc(db, 'wikiArticles', articleId, 'comments', commentId);
    await updateDoc(commentRef, {
      likeCount: increment(1)
    });
  } catch (error) {
    console.error('コメントいいね更新エラー:', error);
    throw error;
  }
}

/**
 * 返信のいいねカウントを増やす
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param replyId 返信ID
 * @returns 更新処理のPromise
 */
export async function incrementReplyLikeCount(
  articleId: string,
  commentId: string,
  replyId: string
): Promise<void> {
  try {
    const replyRef = doc(db, 'wikiArticles', articleId, 'comments', commentId, 'replies', replyId);
    await updateDoc(replyRef, {
      likeCount: increment(1)
    });
  } catch (error) {
    console.error('返信いいね更新エラー:', error);
    throw error;
  }
}

/**
 * すべてのタグを取得する
 * @returns タグ一覧
 */
export async function getAllTags(): Promise<Tag[]> {
  try {
    const q = query(tagsRef, orderBy('count', 'desc'));
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => ({
      name: doc.id,
      ...doc.data()
    })) as Tag[];
  } catch (error) {
    console.error('タグ取得エラー:', error);
    return [];
  }
}

/**
 * タグを更新する（存在しない場合は作成）
 * @param tagNames タグ名の配列
 */
export async function updateTags(tagNames: string[]): Promise<void> {
  try {
    const now = serverTimestamp();
    
    // 各タグに対して更新処理を実行
    const updatePromises = tagNames.map(async (tagName) => {
      const tagRef = doc(searchDb, 'tags', tagName);
      await setDoc(tagRef, {
        count: increment(1),
        lastUsed: now
      }, { merge: true });
    });
    
    await Promise.all(updatePromises);
  } catch (error) {
    console.error('タグ更新エラー:', error);
    throw error;
  }
}

/**
 * タグの使用回数を減らす
 * @param tagNames タグ名の配列
 */
export async function decrementTags(tagNames: string[]): Promise<void> {
  try {
    const updatePromises = tagNames.map(async (tagName) => {
      const tagRef = doc(searchDb, 'tags', tagName);
      await updateDoc(tagRef, {
        count: increment(-1)
      });
    });
    
    await Promise.all(updatePromises);
  } catch (error) {
    console.error('タグ更新エラー:', error);
    throw error;
  }
}

// カウント情報を取得する関数を追加
export async function getArticleCounts(): Promise<{ [articleId: string]: { likeCount: number; usefulCount: number } }> {
  try {
    const countsRef = doc(searchDb, 'counts', 'article');
    const countsDoc = await getDoc(countsRef);

    if (countsDoc.exists()) {
      return countsDoc.data().counts || {};
    }
    return {};
  } catch (error) {
    console.error('カウント情報の取得に失敗:', error);
    return {};
  }
}

// 特定の記事のカウント情報を取得（キャッシュを使わない、常に最新）
export async function _getArticleCountById(articleId: string): Promise<{ likeCount: number; usefulCount: number; dislikeCount: number }> {
  try {
    // 記事概要からカウントを取得（最も信頼性の高いソース）
    const articleSummaryRef = doc(searchDb, 'articleSummaries', articleId);
    const summaryDoc = await getDoc(articleSummaryRef);
    
    if (summaryDoc.exists()) {
      const data = summaryDoc.data();
      return {
        likeCount: data.likeCount || 0,
        usefulCount: data.usefulCount || 0,
        dislikeCount: data.dislikeCount || 0
      };
    }
    
    // 記事概要がない場合、エラー処理
    console.warn('記事概要が見つかりません:', articleId);
    return { likeCount: 0, usefulCount: 0, dislikeCount: 0 };
  } catch (error) {
    console.error('記事カウント情報の取得に失敗:', error);
    return { likeCount: 0, usefulCount: 0, dislikeCount: 0 };
  }
}

// キャッシュ対応バージョンをエクスポート
export const getArticleCountById = withCache(_getArticleCountById, 'article-counts');

// 新しい関数: 著者のカウント情報を取得
export async function getAuthorCounts(): Promise<{ [authorId: string]: { likeCount: number; usefulCount: number } }> {
  try {
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    const countsDoc = await getDoc(authorCountsRef);

    if (countsDoc.exists()) {
      return countsDoc.data().counts || {};
    }
    return {};
  } catch (error) {
    console.error('著者カウント情報の取得に失敗:', error);
    return {};
  }
}

// 新しい関数: 特定の著者のカウント情報を取得
export async function getAuthorCountById(authorId: string): Promise<{ 
  likeCount: number; 
  usefulCount: number;
  articleScoreSum?: number;
  articleCount?: number;
  averageScore?: number; // 平均スコアを追加
}> {
  try {
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    const countsDoc = await getDoc(authorCountsRef);

    if (countsDoc.exists()) {
      const data = countsDoc.data();
      const authorData = data.counts?.[authorId] || { 
        likeCount: 0, 
        usefulCount: 0, 
        articleScoreSum: 0, 
        articleCount: 0 
      };
      
      // 平均スコアを計算して追加
      const averageScore = authorData.articleCount > 0 
        ? authorData.articleScoreSum / authorData.articleCount 
        : 0;
        
      return {
        ...authorData,
        averageScore
      };
    }
    return { likeCount: 0, usefulCount: 0, articleScoreSum: 0, articleCount: 0, averageScore: 0 };
  } catch (error) {
    console.error('著者カウント情報の取得に失敗:', error);
    return { likeCount: 0, usefulCount: 0, articleScoreSum: 0, articleCount: 0, averageScore: 0 };
  }
}

/**
 * 記事作成時に著者のスコアを更新する
 * @param authorId 著者ID
 * @param articleScore 記事スコア
 */
export async function updateAuthorScoreOnArticleCreate(authorId: string, articleScore: number): Promise<void> {
  try {
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    const authorCountsDoc = await getDoc(authorCountsRef);

    if (authorCountsDoc.exists()) {
      const authorData = authorCountsDoc.data();
      const authorCounts = authorData.counts || {};
      const currentAuthorCount = authorCounts[authorId] || { 
        likeCount: 0, 
        usefulCount: 0, 
        articleScoreSum: 0, 
        articleCount: 0 
      };

      authorCounts[authorId] = {
        ...currentAuthorCount,
        articleScoreSum: currentAuthorCount.articleScoreSum + articleScore,
        articleCount: currentAuthorCount.articleCount + 1
      };

      await setDoc(authorCountsRef, {
        counts: authorCounts,
        lastUpdated: Date.now()
      }, { merge: true });
    } else {
      await setDoc(authorCountsRef, {
        counts: {
          [authorId]: { 
            likeCount: 0, 
            usefulCount: 0,
            articleScoreSum: articleScore,
            articleCount: 1
          }
        },
        lastUpdated: Date.now()
      });
    }
  } catch (error) {
    console.error('著者スコア更新エラー:', error);
    throw error;
  }
}

/**
 * 著者のスコア情報を更新する
 * @param authorId 著者ID
 * @param articleId 記事ID
 * @param newScore 新しいスコア値
 */
export async function updateAuthorScore(authorId: string, articleId: string, newScore: number): Promise<void> {
  try {
    const authorCountsRef = doc(searchDb, 'counts', 'author');
    const authorCountsDoc = await getDoc(authorCountsRef);
    
    // 該当著者のすべての記事を取得してスコア再計算
    const authorArticlesQuery = query(
      collection(searchDb, 'articleSummaries'),
      where('authorId', '==', authorId)
    );
    
    const authorArticlesSnapshot = await getDocs(authorArticlesQuery);
    let scoreSum = 0;
    let articleCount = 0;
    let likeCount = 0;
    let usefulCount = 0;
    
    // すべての記事からスコア合計を計算
    authorArticlesSnapshot.forEach(doc => {
      const data = doc.data();
      
      // 特定の記事IDの場合は新しいスコアを使用
      if (doc.id === articleId) {
        scoreSum += newScore;
      } else {
        scoreSum += data.articleScore || 0;
      }
      
      articleCount++;
      likeCount += data.likeCount || 0;
      usefulCount += data.usefulCount || 0;
    });
    
    // 著者のスコア情報を更新
    const authorCounts = authorCountsDoc.exists() ? authorCountsDoc.data().counts || {} : {};
    
    authorCounts[authorId] = {
      likeCount,
      usefulCount,
      articleScoreSum: scoreSum,
      articleCount
    };
    
    await setDoc(authorCountsRef, {
      counts: authorCounts,
      lastUpdated: Date.now()
    }, { merge: true });
    
  } catch (error) {
    console.error('著者スコア更新エラー:', error);
    throw error;
  }
}
